import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InstructionLoader } from "../../src/context/instructions.js";
import { ContextManager } from "../../src/context/manager.js";
import { createTranscript, type TranscriptMessage } from "../../src/messages/transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-code-context-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src", "feature"), { recursive: true });
  return root;
}

function textMessage(id: string, role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("InstructionLoader", () => {
  it("loads user, root, and only active nested AGENTS.md files in precedence order", async () => {
    const root = await workspace();
    const user = join(root, "user-AGENTS.md");
    await writeFile(user, "Use concise explanations.\n");
    await writeFile(join(root, "AGENTS.md"), "Run the project tests.\n");
    await writeFile(join(root, "src", "AGENTS.md"), "TypeScript rules.\n");
    await writeFile(join(root, "src", "feature", "AGENTS.md"), "Feature rules.\n");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "AGENTS.md"), "Docs rules.\n");
    const loader = await InstructionLoader.create({ workspaceRoot: root, userInstructionPath: user });

    const documents = await loader.load(["src/feature/index.ts"]);

    expect(documents.map((item) => [item.level, item.scope, item.content])).toEqual([
      ["user", "global", "Use concise explanations."],
      ["project", ".", "Run the project tests."],
      ["nested", "src", "TypeScript rules."],
      ["nested", "src/feature", "Feature rules."],
    ]);
    expect(documents.some((item) => item.path.includes("docs"))).toBe(false);
  });

  it("ignores active paths outside the workspace and rejects escaping project instruction symlinks", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "agent-code-context-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "AGENTS.md"), "outside\n");
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    expect(await loader.load([join(outside, "file.ts")])).toEqual([]);

    await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    await expect(loader.load()).rejects.toThrow("resolves outside the workspace");
  });
});

describe("ContextManager", () => {
  it("injects scoped instructions without mutating the durable transcript", async () => {
    const root = await workspace();
    await writeFile(join(root, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(root, "src", "AGENTS.md"), "Source rule.\n");
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({ instructions: loader, maxTokens: 2_000 });
    const durable = createTranscript([textMessage("user-1", "user", "Inspect src/index.ts")]);

    const prepared = await manager.prepare(durable, []);

    expect(durable.messages).toHaveLength(1);
    expect(prepared.transcript.messages).toHaveLength(3);
    const injected = prepared.transcript.messages[1]?.content[0];
    expect(injected).toMatchObject({ type: "text" });
    if (injected?.type === "text") {
      expect(injected.text).toContain("Root rule.");
      expect(injected.text).toContain("Source rule.");
      expect(injected.text).toContain("never grant tool permission");
    }
    expect(prepared.report.instructionFiles.map((item) => item.scope)).toEqual([".", "src"]);
    expect(prepared.report.compressed).toBe(false);
  });

  it("compresses old history into a labeled summary that preserves goals, pending work, and important results", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 420,
      systemPrompt: "coding agent",
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const oldMessages: TranscriptMessage[] = [
      textMessage("goal", "user", `Fix the payment retry bug. ${"context ".repeat(45)}`),
      textMessage("plan", "assistant", "TODO: update retry state after inspecting the failing test."),
      {
        id: "call",
        role: "assistant",
        content: [{ type: "tool_call", id: "test-1", name: "run_tests", input: { path: "src/payment.ts" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "result",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "test-1", status: "error", content: "retry assertion failed" }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("noise-1", "assistant", "analysis ".repeat(55)),
      textMessage("noise-2", "user", "continue with the same goal " + "detail ".repeat(45)),
    ];
    const durable = createTranscript([
      ...oldMessages,
      textMessage("recent-a", "assistant", "I will now apply the focused fix."),
      textMessage("recent-u", "user", "Proceed."),
    ]);

    const prepared = await manager.prepare(durable, []);
    const systemText = prepared.transcript.messages
      .filter((item) => item.role === "system")
      .flatMap((item) => item.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    expect(prepared.report.compressed).toBe(true);
    expect(prepared.report.omittedMessages).toBeGreaterThan(0);
    expect(prepared.report.estimatedTokens).toBeLessThanOrEqual(420);
    expect(systemText).toContain("Compressed context summary");
    expect(systemText).toContain("Fix the payment retry bug");
    expect(systemText).toContain("TODO: update retry state");
    expect(systemText).toContain("retry assertion failed");
    expect(durable.messages).toHaveLength(8);
  });

  it("reports tool schema usage as a separate context component", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({ instructions: loader, maxTokens: 2_000 });
    const prepared = await manager.prepare(createTranscript(), [{
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
    }]);

    expect(prepared.report.components.find((item) => item.component === "tool_schemas"))
      .toMatchObject({ detail: "1 tool(s)", estimatedTokens: expect.any(Number) });
  });
});
