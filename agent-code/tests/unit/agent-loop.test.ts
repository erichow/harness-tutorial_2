import { describe, expect, it } from "vitest";

import { createTranscript } from "../../src/messages/transcript.js";
import { MockProvider, type MockProviderResponse } from "../../src/providers/mock.js";
import { runTurn } from "../../src/runtime/agent.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import type { JsonObject } from "../../src/protocol/json.js";
import {
  InMemoryToolExecutor,
  type ToolImplementation,
} from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/tool.js";

const noTools = new InMemoryToolExecutor([]);

function response(
  ...events: MockProviderResponse["events"]
): MockProviderResponse {
  return { events };
}

function scriptedIds(): () => string {
  let next = 0;
  return () => `id-${next++}`;
}

const fixedNow = (): Date => new Date("2026-07-22T12:00:00.000Z");

function echoTool(overrides: Partial<ToolImplementation> = {}): ToolImplementation {
  return {
    definition: {
      name: "echo",
      description: "Echo a text value",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    validate(input) {
      return typeof input.text === "string" ? undefined : "text must be a string";
    },
    async execute(input) {
      return { content: String(input.text), data: { echoed: input.text ?? null } };
    },
    ...overrides,
  };
}

describe("runTurn", () => {
  it("streams a text response into events and the transcript", async () => {
    const provider = new MockProvider([
      response(
        { type: "reasoning_summary_delta", delta: "Greet " },
        { type: "reasoning_summary_delta", delta: "briefly." },
        { type: "text_delta", delta: "Hel" },
        { type: "text_delta", delta: "lo" },
        { type: "usage", inputTokens: 4, outputTokens: 2 },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);
    const events: RuntimeEvent[] = [];
    const original = createTranscript();

    const result = await runTurn({
      provider,
      transcript: original,
      tools: noTools,
      emit: (event) => { events.push(event); },
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(result.reason).toBe("completed");
    expect(result.steps).toBe(1);
    expect(original.messages).toHaveLength(0);
    expect(result.transcript.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          { type: "reasoning_summary", text: "Greet briefly." },
          { type: "text", text: "Hello" },
        ],
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "reasoning_summary_delta",
      "reasoning_summary_delta",
      "text_delta",
      "text_delta",
      "usage",
      "provider_response",
      "turn_finished",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(events.map((event) => event.turnId))).toEqual(new Set(["id-0"]));
  });

  it("sends a derived context to the provider but appends output to the durable transcript", async () => {
    const provider = new MockProvider([
      response(
        { type: "text_delta", delta: "bounded" },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);
    const durable = createTranscript([{
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "original goal" }],
      createdAt: "2026-07-23T00:00:00.000Z",
    }]);
    const context = {
      async prepare() {
        return {
          transcript: createTranscript([{
            id: "derived-system",
            role: "system",
            content: [{ type: "text", text: "derived context" }],
            createdAt: "2026-07-23T00:00:00.000Z",
          }, ...durable.messages]),
          report: {
            maxTokens: 100,
            estimatedTokens: 20,
            compressed: false,
            originalMessages: 1,
            includedMessages: 1,
            omittedMessages: 0,
            activePaths: [],
            instructionFiles: [],
            components: [],
          },
        };
      },
    };

    const result = await runTurn({
      provider,
      transcript: durable,
      tools: noTools,
      context,
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(provider.requests[0]?.transcript.messages.map((item) => item.role))
      .toEqual(["system", "user"]);
    expect(result.transcript.messages.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(result.transcript.messages.some((item) => item.id === "derived-system")).toBe(false);
    expect(result.context).toMatchObject({ estimatedTokens: 20, originalMessages: 1 });
  });

  it("executes a tool and sends its result to the next provider step", async () => {
    const provider = new MockProvider([
      response(
        {
          type: "tool_call",
          call: { type: "tool_call", id: "call-1", name: "echo", input: { text: "hi" } },
        },
        { type: "response_completed", finishReason: "tool_calls" },
      ),
      response(
        { type: "text_delta", delta: "The tool said hi." },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);
    const events: RuntimeEvent[] = [];

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: new InMemoryToolExecutor([echoTool()]),
      emit: (event) => { events.push(event); },
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(result.reason).toBe("completed");
    expect(result.steps).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.transcript.messages).toMatchObject([
      { role: "assistant", content: [{ type: "tool_call", id: "call-1" }] },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", status: "success" }],
      },
    ]);
    expect(events.map((event) => event.type)).toContain("tool_call_started");
    expect(events.map((event) => event.type)).toContain("tool_call_finished");
  });

  it("supports multiple tool calls across multiple provider steps", async () => {
    const calls: string[] = [];
    const tools = new InMemoryToolExecutor([
      echoTool({
        async execute(input) {
          calls.push(String(input.text));
          return { content: String(input.text) };
        },
      }),
    ]);
    const toolCall = (id: string, text: string) => ({
      type: "tool_call" as const,
      call: { type: "tool_call" as const, id, name: "echo", input: { text } },
    });
    const provider = new MockProvider([
      response(
        toolCall("call-1", "one"),
        toolCall("call-2", "two"),
        { type: "response_completed", finishReason: "tool_calls" },
      ),
      response(
        toolCall("call-3", "three"),
        { type: "response_completed", finishReason: "tool_calls" },
      ),
      response(
        { type: "text_delta", delta: "done" },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools,
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(result.reason).toBe("completed");
    expect(result.steps).toBe(3);
    expect(calls).toEqual(["one", "two", "three"]);
  });

  it("continues from a failed test through diagnosis and repair to a passing test", async () => {
    const executed: string[] = [];
    const tools = new InMemoryToolExecutor([
      {
        definition: { name: "run_tests", description: "test", inputSchema: {} },
        async execute(input) {
          const outcome = String(input.outcome);
          executed.push(`test:${outcome}`);
          return { content: outcome, data: { outcome, testStatus: outcome } };
        },
      },
      {
        definition: { name: "read_file", description: "read", inputSchema: {} },
        async execute() {
          executed.push("read");
          return { content: "relevant source" };
        },
      },
      {
        definition: { name: "apply_patch", description: "patch", inputSchema: {} },
        async execute() {
          executed.push("patch");
          return { content: "changed" };
        },
      },
    ]);
    const toolStep = (id: string, name: string, input: JsonObject = {}) => response(
      { type: "tool_call", call: { type: "tool_call", id, name, input } },
      { type: "response_completed", finishReason: "tool_calls" },
    );
    const provider = new MockProvider([
      toolStep("test-fail", "run_tests", { outcome: "failed" }),
      toolStep("diagnose", "read_file"),
      toolStep("repair", "apply_patch"),
      toolStep("test-pass", "run_tests", { outcome: "passed" }),
      response(
        { type: "text_delta", delta: "fixed" },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools,
      limits: { maxSteps: 6 },
    });

    expect(executed).toEqual(["test:failed", "read", "patch", "test:passed"]);
    expect(result.tests).toEqual({
      status: "passed",
      runs: 2,
      repairRounds: 1,
      lastOutcome: "passed",
    });
  });

  it("returns a repeated-call error to the model without re-running the handler", async () => {
    let executions = 0;
    const echo: Tool = {
      definition: {
        name: "echo",
        description: "Echo a text value",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      sideEffects: [],
      async handler(input) {
        executions += 1;
        return { content: String(input.text) };
      },
    };
    const repeatedCall = (id: string) => response(
      {
        type: "tool_call",
        call: { type: "tool_call", id, name: "echo", input: { text: "same" } },
      },
      { type: "response_completed", finishReason: "tool_calls" },
    );
    const provider = new MockProvider([
      repeatedCall("call-1"),
      repeatedCall("call-2"),
      response(
        { type: "text_delta", delta: "stopped repeating" },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);

    const registry = new ToolRegistry([echo], { maxIdenticalCalls: 1 });
    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: registry.createExecutor(),
      now: fixedNow,
      createId: scriptedIds(),
    });
    const repeatedResult = provider.requests[2]?.transcript.messages
      .at(-1)?.content.at(0);

    expect(result.reason).toBe("completed");
    expect(executions).toBe(1);
    expect(repeatedResult).toMatchObject({
      type: "tool_result",
      status: "error",
      error: { code: "repeated_call" },
    });
  });

  it.each([
    {
      name: "unknown tool",
      tools: new InMemoryToolExecutor([]),
      call: { type: "tool_call" as const, id: "bad-1", name: "missing", input: {} },
      code: "unknown_tool",
    },
    {
      name: "invalid arguments",
      tools: new InMemoryToolExecutor([echoTool()]),
      call: { type: "tool_call" as const, id: "bad-2", name: "echo", input: { text: 3 } },
      code: "invalid_arguments",
    },
    {
      name: "tool exception",
      tools: new InMemoryToolExecutor([
        echoTool({
          async execute() {
            throw new Error("disk unavailable");
          },
        }),
      ]),
      call: { type: "tool_call" as const, id: "bad-3", name: "echo", input: { text: "x" } },
      code: "execution_failed",
    },
  ])("returns $name to the model as a tool error", async ({ tools, call, code }) => {
    const provider = new MockProvider([
      response(
        { type: "tool_call", call },
        { type: "response_completed", finishReason: "tool_calls" },
      ),
      response(
        { type: "text_delta", delta: "recovered" },
        { type: "response_completed", finishReason: "stop" },
      ),
    ]);

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools,
      now: fixedNow,
      createId: scriptedIds(),
    });
    const resultBlock = provider.requests[1]?.transcript.messages
      .at(-1)?.content.at(0);

    expect(result.reason).toBe("completed");
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      status: "error",
      error: { code, retryable: false },
      output: { truncated: false },
    });
  });

  it("stops with max_steps after the configured number of provider responses", async () => {
    const call = (id: string) => response(
      {
        type: "tool_call",
        call: { type: "tool_call", id, name: "echo", input: { text: id } },
      },
      { type: "response_completed", finishReason: "tool_calls" },
    );
    const provider = new MockProvider([call("call-1"), call("call-2")]);
    const events: RuntimeEvent[] = [];

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: new InMemoryToolExecutor([echoTool()]),
      limits: { maxSteps: 2 },
      emit: (event) => { events.push(event); },
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(result.reason).toBe("max_steps");
    expect(result.steps).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "turn_finished", reason: "max_steps" });
  });

  it("stops before tool execution when provider-reported token usage exceeds the budget", async () => {
    let executions = 0;
    const provider = new MockProvider([
      response(
        { type: "usage", inputTokens: 11, outputTokens: 2 },
        {
          type: "tool_call",
          call: { type: "tool_call", id: "too-late", name: "echo", input: { text: "no" } },
        },
        { type: "response_completed", finishReason: "tool_calls" },
      ),
    ]);
    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: new InMemoryToolExecutor([echoTool({
        async execute() {
          executions += 1;
          return { content: "unexpected" };
        },
      })]),
      limits: { maxSteps: 2, maxInputTokens: 10 },
    });

    expect(result.reason).toBe("max_tokens");
    expect(executions).toBe(0);
    expect(result.tests.status).toBe("not_run");
  });

  it("cancels a pending provider at the wall-clock turn limit", async () => {
    const provider = new MockProvider([response({ type: "wait_for_abort" })]);
    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: noTools,
      limits: { maxSteps: 2, maxDurationMs: 20 },
    });

    expect(result.reason).toBe("max_duration");
    expect(result.tests).toEqual({ status: "not_run", runs: 0, repairRounds: 0 });
  });

  it("cancels while a provider stream is pending", async () => {
    const controller = new AbortController();
    const provider = new MockProvider([
      response({ type: "wait_for_abort" }),
    ]);
    const events: RuntimeEvent[] = [];

    const pending = runTurn({
      provider,
      transcript: createTranscript(),
      tools: noTools,
      signal: controller.signal,
      emit: (event) => { events.push(event); },
      now: fixedNow,
      createId: scriptedIds(),
    });
    queueMicrotask(() => controller.abort(new Error("user pressed Ctrl-C")));
    const result = await pending;

    expect(result.reason).toBe("cancelled");
    expect(events.slice(-2)).toMatchObject([
      { type: "error", category: "cancelled" },
      { type: "turn_finished", reason: "cancelled" },
    ]);
  });

  it("turns a malformed provider stream into a provider error", async () => {
    const provider = new MockProvider([
      response({ type: "text_delta", delta: "incomplete" }),
    ]);
    const events: RuntimeEvent[] = [];

    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: noTools,
      emit: (event) => { events.push(event); },
      now: fixedNow,
      createId: scriptedIds(),
    });

    expect(result.reason).toBe("error");
    expect(events.slice(-2)).toMatchObject([
      { type: "error", category: "provider", message: expect.stringContaining("response_completed") },
      { type: "turn_finished", reason: "error" },
    ]);
  });
});
