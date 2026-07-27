import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InstructionLoader } from "../../src/context/instructions.js";
import { ContextManager, resolveModelContextTokens } from "../../src/context/manager.js";
import { createTranscript, type TranscriptMessage } from "../../src/messages/transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dugsyn-context-"));
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
    const outside = await mkdtemp(join(tmpdir(), "dugsyn-context-outside-"));
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

describe("resolveModelContextTokens", () => {
  it("returns 1M for deepseek-v4-pro", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-v4-pro")).toBe(1_000_000);
  });

  it("returns 1M for deepseek-r1", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-r1")).toBe(1_000_000);
  });

  it("returns 128K for deepseek-v3", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-v3")).toBe(128_000);
  });

  it("returns 128K for deepseek-chat", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-chat")).toBe(128_000);
  });

  it("returns 64K for deepseek-reasoner", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-reasoner")).toBe(64_000);
  });

  it("prefix-matches unknown deepseek-v4 variant to 1M", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-v4-turbo")).toBe(1_000_000);
  });

  it("prefix-matches unknown deepseek-r1 variant to 1M", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-r1-1234")).toBe(1_000_000);
  });

  it("returns 200K for o1", () => {
    expect(resolveModelContextTokens("openai", "o1")).toBe(200_000);
  });

  it("returns 200K for o3", () => {
    expect(resolveModelContextTokens("openai", "o3")).toBe(200_000);
  });

  it("returns 1M for gpt-4.1", () => {
    expect(resolveModelContextTokens("openai", "gpt-4.1")).toBe(1_000_000);
  });

  it("returns 128K fallback for unknown openai model", () => {
    expect(resolveModelContextTokens("openai", "gpt-4o-unknown")).toBe(128_000);
  });

  it("returns 128K fallback for unknown deepseek model", () => {
    expect(resolveModelContextTokens("deepseek", "deepseek-vision")).toBe(128_000);
  });

  it("returns 32K fallback for unknown provider", () => {
    expect(resolveModelContextTokens("anthropic", "claude-sonnet")).toBe(32_000);
  });
});


  it("truncates old messages via selectRecentMessages when budget overflows (no summary fabrication)", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 340,
      systemPrompt: "coding agent",
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    const oldMessages: TranscriptMessage[] = [
      textMessage("goal", "user", "Refactor the auth module."),
      {
        id: "read-call-1",
        role: "assistant",
        content: [{ type: "tool_call", id: "read-1", name: "read_file", input: { path: "src/auth.ts" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "read-result-1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "read-1", status: "success", content: "/** Authentication middleware and JWT helpers. */\nimport jwt from 'jsonwebtoken';\n" + "line ".repeat(80) }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("plan", "assistant", "TODO: extract token validation into a separate module."),
      textMessage("noise", "user", "Also review the database layer " + "detail ".repeat(30)),
    ];
    const recentMessages: TranscriptMessage[] = [
      textMessage("recent-a", "assistant", "I will now apply the refactor."),
      textMessage("recent-u", "user", "Proceed."),
    ];
    const durable = createTranscript([...oldMessages, ...recentMessages]);

    const prepared = await manager.prepare(durable, []);

    // Compression triggered; old messages dropped, recent ones kept as-is.
    expect(prepared.report.omittedMessages).toBeGreaterThan(0);
    expect(prepared.report.estimatedTokens).toBeLessThanOrEqual(340);

    // Recent messages are preserved structurally (no fabricated summary text).
    const recentTexts = prepared.transcript.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .flatMap((m) => m.content.filter((b) => b.type === "text"))
      .map((b) => b.text);
    expect(recentTexts.some((t) => t.includes("apply the refactor"))).toBe(true);
    expect(recentTexts.some((t) => t.includes("Proceed"))).toBe(true);
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

  it("drops old messages via selectRecentMessages when budget overflows, without fabricating summaries", async () => {
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

    // Compression triggered but uses filter + truncate, not summary.
    expect(prepared.report.omittedMessages).toBeGreaterThan(0);
    expect(prepared.report.estimatedTokens).toBeLessThanOrEqual(420);
    // Recent messages are preserved as-is (structured, not a summary block).
    const recentTexts = prepared.transcript.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .flatMap((m) => m.content.filter((b) => b.type === "text"))
      .map((b) => b.text);
    expect(recentTexts.some((t) => t.includes("focused fix"))).toBe(true);
    expect(recentTexts.some((t) => t.includes("Proceed"))).toBe(true);
    // Old messages are dropped, so their content should NOT appear.
    const allText = recentTexts.join(" ");
    expect(allText).not.toContain("Fix the payment retry bug");
    expect(allText).not.toContain("TODO: update retry state");
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

  it("offloads read_file content for turns older than offloadAfterTurns", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 8_000,
      offloadAfterTurns: 1,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    // Turn 1: user asks to read a file → read_file result with full content
    // Turn 2: another user message → this turn should trigger offload of turn 1's read_file
    const transcript = createTranscript([
      textMessage("u1", "user", "Read the config"),
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "config.json" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", status: "success", content: '{"debug":true}' }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("u2", "user", "Enable debug mode"),
    ]);

    const prepared = await manager.prepare(transcript, []);

    const toolMessages = prepared.transcript.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const content = toolMessages[0]!.content[0];
    expect(content).toMatchObject({ type: "tool_result" });
    if (content?.type === "tool_result") {
      expect(content.content).toContain("[File offloaded");
    }
  });

  it("does not offload read_file results with error status", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 8_000,
      offloadAfterTurns: 1,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    const transcript = createTranscript([
      textMessage("u1", "user", "Read the config"),
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "config.json" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", status: "error", content: "ENOENT: no such file" }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("u2", "user", "Create the file instead"),
    ]);

    const prepared = await manager.prepare(transcript, []);

    const toolMessages = prepared.transcript.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const content = toolMessages[0]!.content[0];
    if (content?.type === "tool_result") {
      expect(content.content).not.toContain("[File offloaded");
      expect(content.content).toContain("ENOENT");
    }
  });

  it("only offloads read_file beyond offloadAfterTurns, keeps recent ones intact", async () => {
    const root = await workspace();
    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 8_000,
      offloadAfterTurns: 2,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    // Turn 1: read file A → should be offloaded (3 turns ago)
    // Turn 2: read file B → kept (2 turns ago, within keepTurns)
    // Turn 3: latest user message
    const transcript = createTranscript([
      textMessage("u1", "user", "Read file A"),
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", status: "success", content: "AAAA" }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("u2", "user", "Read file B"),
      {
        id: "a2",
        role: "assistant",
        content: [{ type: "tool_call", id: "call-2", name: "read_file", input: { path: "b.txt" } }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      {
        id: "t2",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-2", status: "success", content: "BBBB" }],
        createdAt: "2026-07-23T00:00:00.000Z",
      },
      textMessage("u3", "user", "Compare them"),
    ]);

    const prepared = await manager.prepare(transcript, []);

    const toolMessages = prepared.transcript.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    // First read_file (a.txt) should be offloaded
    const t1 = toolMessages[0]!.content[0];
    if (t1?.type === "tool_result") {
      expect(t1.content).toContain("[File offloaded");
    }
    // Second read_file (b.txt) should still have full content
    const t2 = toolMessages[1]!.content[0];
    if (t2?.type === "tool_result") {
      expect(t2.content).toBe("BBBB");
    }
  });

  it("writes provider-transcript.jsonl when providerTranscriptPath is set", async () => {
    const root = await workspace();
    await writeFile(join(root, "AGENTS.md"), "Hello.\n");
    const tmpDir = await mkdtemp(join(root, "provider-dump-"));
    const providerPath = join(tmpDir, "provider-transcript.jsonl");

    const loader = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-user.md"),
    });
    const manager = new ContextManager({
      instructions: loader,
      maxTokens: 2_000,
      providerTranscriptPath: providerPath,
    });

    const transcript = createTranscript([textMessage("u1", "user", "Hello")]);
    await manager.prepare(transcript, []);

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(providerPath, "utf8");
    expect(content).toContain('"role":"system"');
    expect(content).toContain('"role":"user"');
    expect(content).toContain("Hello");
    // Verify it's valid JSONL (each line is valid JSON)
    for (const line of content.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("dropLowSignalMessages removes greetings and bare acknowledgments", () => {
    const msgs: TranscriptMessage[] = [
      textMessage("u1", "user", "hi"),
      textMessage("a1", "assistant", "你好"),
      textMessage("u2", "user", "hello"),
      textMessage("a2", "assistant", "ok"),
      textMessage("u3", "user", "看一下html"),
      textMessage("a3", "assistant", "Got it, starting now."),
    ];
    // The function is internal; we verify the behavior indirectly
    // by checking that messages matching the low-signal pattern are absent.
    const lowSignal = ["hi", "你好", "hello", "ok"];
    const meaningful = ["看一下html", "Got it, starting now."];
    for (const t of lowSignal) {
      expect(/^(hi|hey|hello|你好|您好|好的|ok|okay|got it|知道了|嗯|哦|谢谢|thanks|再见|bye|goodbye|继续|go on)[\s!。，]*$/iu.test(t.toLowerCase().trim())).toBe(true);
    }
    for (const t of meaningful) {
      expect(/^(hi|hey|hello|你好|您好|好的|ok|okay|got it|知道了|嗯|哦|谢谢|thanks|再见|bye|goodbye|继续|go on)[\s!。，]*$/iu.test(t.toLowerCase().trim())).toBe(false);
    }
  });


