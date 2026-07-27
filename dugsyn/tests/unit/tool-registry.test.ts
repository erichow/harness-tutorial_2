import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { serializeToolResultForProvider } from "../../src/tools/result.js";
import type { Tool } from "../../src/tools/tool.js";

const signal = new AbortController().signal;

function toolCall(id: string, name: string, input: JsonObject) {
  return { type: "tool_call" as const, id, name, input };
}

function echoTool(handler: Tool["handler"] = async (input) => ({
  content: String(input.text),
  data: { echoed: input.text ?? null },
})): Tool {
  return {
    definition: {
      name: "echo",
      description: "Echo a string",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    sideEffects: [],
    handler,
  };
}

describe("ToolRegistry", () => {
  it("returns a stable unknown-tool envelope", async () => {
    const result = await new ToolRegistry([]).createExecutor().execute(
      toolCall("call-missing", "missing", {}),
      { signal },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "unknown_tool", retryable: false },
      output: { truncated: false },
    });
  });

  it.each([
    ["missing required fields", {}, "required property"],
    ["wrong field types", { text: 42 }, "must be string"],
    ["additional fields", { text: "ok", extra: true }, "additional properties"],
  ])("rejects %s before executing a handler", async (_name, input, message) => {
    const handler = vi.fn<Tool["handler"]>(async () => ({ content: "unexpected" }));
    const executor = new ToolRegistry([echoTool(handler)]).createExecutor();

    const result = await executor.execute(
      toolCall("call-invalid", "echo", input),
      { signal },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "error",
      error: { code: "invalid_arguments", retryable: false },
      output: { truncated: false },
    });
    expect(result.content).toContain(message);
  });

  it("turns handler failures and malformed handler results into stable errors", async () => {
    const throwing = new ToolRegistry([
      echoTool(async () => { throw new Error("disk unavailable"); }),
    ]).createExecutor();
    const malformed = new ToolRegistry([
      echoTool(async () => ({ content: "ok", data: { invalid: undefined } } as never)),
    ]).createExecutor();

    await expect(
      throwing.execute(toolCall("call-throw", "echo", { text: "x" }), { signal }),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "execution_failed", message: expect.stringContaining("disk unavailable") },
    });
    await expect(
      malformed.execute(toolCall("call-malformed", "echo", { text: "x" }), { signal }),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "execution_failed", message: expect.stringContaining("JSON-compatible") },
    });
  });

  it("limits UTF-8 output by bytes and preserves a tool-owned page cursor", async () => {
    const registry = new ToolRegistry([
      echoTool(async (_input, context) => {
        expect(context.maxOutputBytes).toBe(5);
        return {
          content: "🙂🙂",
          data: { localOnly: true },
          nextCursor: "page-2",
        };
      }),
    ], { maxOutputBytes: 5 });

    const result = await registry.createExecutor().execute(
      toolCall("call-page", "echo", { text: "x" }),
      { signal },
    );

    expect(result).toMatchObject({
      status: "success",
      content: "🙂",
      data: { localOnly: true },
      output: {
        contentBytes: 4,
        totalContentBytes: 8,
        truncated: true,
        nextCursor: "page-2",
      },
    });
    expect(JSON.parse(serializeToolResultForProvider(result))).toEqual({
      status: "success",
      content: "🙂",
      output: {
        contentBytes: 4,
        totalContentBytes: 8,
        truncated: true,
        nextCursor: "page-2",
      },
    });
  });

  it("blocks canonical repeated calls while fresh executors reset the counter", async () => {
    const handler = vi.fn<Tool["handler"]>(async () => ({ content: "ok" }));
    const pairTool: Tool = {
      definition: {
        name: "pair",
        description: "Read a pair",
        inputSchema: {
          type: "object",
          properties: { left: { type: "string" }, right: { type: "string" } },
          required: ["left", "right"],
          additionalProperties: false,
        },
      },
      sideEffects: ["read_workspace"],
      handler,
    };
    const registry = new ToolRegistry([pairTool], { maxIdenticalCalls: 1 });
    const firstTurn = registry.createExecutor();

    const first = await firstTurn.execute(
      toolCall("call-1", "pair", { left: "a", right: "b" }),
      { signal },
    );
    const repeated = await firstTurn.execute(
      toolCall("call-2", "pair", { right: "b", left: "a" }),
      { signal },
    );
    const nextTurn = await registry.createExecutor().execute(
      toolCall("call-3", "pair", { left: "a", right: "b" }),
      { signal },
    );

    expect(first.status).toBe("success");
    expect(repeated).toMatchObject({
      status: "error",
      error: { code: "repeated_call" },
    });
    expect(nextTurn.status).toBe("success");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(registry.getSideEffects("pair")).toEqual(["read_workspace"]);
  });

  it("rejects duplicate tools and invalid registry limits", () => {
    expect(() => new ToolRegistry([echoTool(), echoTool()])).toThrow("Duplicate tool");
    expect(() => new ToolRegistry([], { maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes must be a positive integer",
    );
  });
});
