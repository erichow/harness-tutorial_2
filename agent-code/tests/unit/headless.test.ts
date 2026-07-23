import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createTranscript, type Transcript } from "../../src/messages/transcript.js";
import {
  parseHeadlessArgs,
  runHeadless,
  runHeadlessCli,
  type HeadlessIO,
  type HeadlessSession,
} from "../../src/cli/headless.js";
import type { RuntimeEvent, TurnFinishReason } from "../../src/runtime/events.js";
import type { RunTurnResult } from "../../src/runtime/agent.js";
import { MockProvider } from "../../src/providers/mock.js";

const temporaryDirectories: string[] = [];
const testsNotRun = {
  status: "not_run" as const,
  runs: 0,
  repairRounds: 0,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (path) => await rm(path, { recursive: true, force: true }),
  ));
});

describe("headless argument contract", () => {
  it("parses an inline prompt and shared provider options", () => {
    expect(parseHeadlessArgs([
      "--print", "inspect this project",
      "--provider", "openai",
      "--model", "test-model",
      "--output-format", "json",
    ], {}, "/workspace")).toMatchObject({
      prompt: "inspect this project",
      provider: "openai",
      model: "test-model",
      inputFormat: "text",
      outputFormat: "json",
    });
  });

  it("rejects ambiguous and unsupported formats", () => {
    expect(() => parseHeadlessArgs([
      "--print", "prompt", "--input-format", "jsonl",
      "--provider", "openai", "--model", "test",
    ], {}, "/workspace")).toThrow("cannot be combined");
    expect(() => parseHeadlessArgs([
      "--print", "--output-format", "yaml",
      "--provider", "openai", "--model", "test",
    ], {}, "/workspace")).toThrow("text, json, or jsonl");
  });
});

describe("headless protocol", () => {
  it("reads a text prompt from stdin and writes only final text to stdout", async () => {
    const output = memoryIO("explain this\n");
    const session = fakeSession();

    const exitCode = await runHeadless({
      inputFormat: "text",
      outputFormat: "text",
      io: output.io,
      session: session.value,
      now: fixedNow,
      createId: incrementalIds(),
    });

    expect(exitCode).toBe(0);
    expect(output.stdout.join("")).toBe("answer: explain this\n");
    expect(output.stderr).toEqual([]);
    expect(session.persisted).toHaveLength(2);
    expect(session.persisted[0]?.messages.at(-1)?.role).toBe("user");
    expect(session.events.map((event) => event.type)).toEqual([
      "turn_started",
      "text_delta",
      "turn_finished",
    ]);
  });

  it("streams correlated events and results for multiple JSONL requests", async () => {
    const output = memoryIO([
      '{"protocolVersion":1,"type":"request","requestId":"first","prompt":"one"}',
      '{"protocolVersion":1,"type":"request","requestId":"second","prompt":"two"}',
      "",
    ].join("\n"));
    const session = fakeSession();

    const exitCode = await runHeadless({
      inputFormat: "jsonl",
      outputFormat: "jsonl",
      io: output.io,
      session: session.value,
      now: fixedNow,
      createId: incrementalIds(),
    });

    const lines = output.stdout.join("").trim().split("\n").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(exitCode).toBe(0);
    expect(lines.map((line) => line.type)).toEqual([
      "event", "event", "event", "result",
      "event", "event", "event", "result",
    ]);
    expect(lines.slice(0, 4).every((line) => line.requestId === "first")).toBe(true);
    expect(lines.slice(4).every((line) => line.requestId === "second")).toBe(true);
    expect(lines.filter((line) => line.type === "result").map((line) => line.text))
      .toEqual(["answer: one", "answer: two"]);
    expect(output.stderr).toEqual([]);
  });

  it("writes one structured batch document for JSON output", async () => {
    const output = memoryIO("");
    const session = fakeSession();

    const exitCode = await runHeadless({
      prompt: "one shot",
      inputFormat: "text",
      outputFormat: "json",
      io: output.io,
      session: session.value,
      now: fixedNow,
      createId: incrementalIds(),
    });

    const batch = JSON.parse(output.stdout.join("")) as {
      type: string;
      sessionId: string;
      exitCode: number;
      results: Array<{ text: string }>;
    };
    expect(exitCode).toBe(0);
    expect(batch).toMatchObject({
      type: "batch_result",
      sessionId: "session-test",
      exitCode: 0,
    });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.text).toBe("answer: one shot");
  });

  it("reports the exact malformed JSONL line without contaminating stdout", async () => {
    const output = memoryIO([
      "",
      '{"protocolVersion":1,"type":"request","requestId":"bad","prompt":',
      "",
    ].join("\n"));

    await expect(runHeadless({
      inputFormat: "jsonl",
      outputFormat: "jsonl",
      io: output.io,
      session: fakeSession().value,
    })).rejects.toThrow("JSONL line 2 is not valid JSON");
    expect(output.stdout).toEqual([]);
  });

  it("rejects duplicate request IDs in one input stream", async () => {
    const output = memoryIO([
      '{"protocolVersion":1,"type":"request","requestId":"same","prompt":"one"}',
      '{"protocolVersion":1,"type":"request","requestId":"same","prompt":"two"}',
      "",
    ].join("\n"));

    await expect(runHeadless({
      inputFormat: "jsonl",
      outputFormat: "jsonl",
      io: output.io,
      session: fakeSession().value,
    })).rejects.toThrow("Duplicate requestId: same");
  });

  it.each([
    {
      name: "budget exhaustion",
      reason: "max_tokens" as const,
      events: [] as RuntimeEvent[],
      exitCode: 3,
      diagnostic: "max_tokens",
    },
    {
      name: "permission denial",
      reason: "completed" as const,
      events: [permissionDeniedEvent()] as RuntimeEvent[],
      exitCode: 4,
      diagnostic: "permission policy",
    },
    {
      name: "provider failure",
      reason: "error" as const,
      events: [errorEvent("provider", "upstream failed")] as RuntimeEvent[],
      exitCode: 1,
      diagnostic: "upstream failed",
    },
    {
      name: "cancellation",
      reason: "cancelled" as const,
      events: [errorEvent("cancelled", "Turn cancelled")] as RuntimeEvent[],
      exitCode: 130,
      diagnostic: "cancelled",
    },
  ])("maps $name to a stable exit code", async ({
    reason,
    events,
    exitCode,
    diagnostic,
  }) => {
    const output = memoryIO("");
    const session = fakeSession({ reason, extraEvents: events });

    const actual = await runHeadless({
      prompt: "run",
      inputFormat: "text",
      outputFormat: "json",
      io: output.io,
      session: session.value,
      now: fixedNow,
      createId: incrementalIds(),
    });

    expect(actual).toBe(exitCode);
    expect(output.stderr.join("")).toContain(diagnostic);
    const batch = JSON.parse(output.stdout.join("")) as {
      exitCode: number;
      results: Array<{ exitCode: number }>;
    };
    expect(batch.exitCode).toBe(exitCode);
    expect(batch.results[0]?.exitCode).toBe(exitCode);
  });

  it("returns exit code 1 and uses stderr for an unexpected bootstrap failure", async () => {
    const workspace = await temporaryDirectory();
    const sessions = join(workspace, "sessions");
    const missingUserConfig = join(workspace, "missing-user-config.json");
    const output = memoryIO("");

    const exitCode = await runHeadlessCli([
      "--print", "hello",
      "--provider", "openai",
      "--model", "offline",
      "--session-dir", sessions,
    ], {
      OPENAI_API_KEY: "not-used",
      AGENT_CODE_USER_CONFIG: missingUserConfig,
    }, {
      cwd: workspace,
      io: output.io,
      createProvider: () => {
        throw new Error("provider bootstrap exploded");
      },
    });

    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toContain("Internal error: provider bootstrap exploded");
  });

  it("returns exit code 2 for missing credentials before reading stdin", async () => {
    const workspace = await temporaryDirectory();
    const output = memoryIO("should not be consumed");

    const exitCode = await runHeadlessCli([
      "--print",
      "--provider", "openai",
      "--model", "offline",
      "--session-dir", join(workspace, "sessions"),
    ], {
      AGENT_CODE_USER_CONFIG: join(workspace, "missing-user-config.json"),
    }, {
      cwd: workspace,
      io: output.io,
    });

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toContain("OPENAI_API_KEY is required");
  });

  it("keeps MCP bootstrap diagnostics on stderr and JSON protocol on stdout", async () => {
    const workspace = await temporaryDirectory();
    const output = memoryIO("");
    const userConfig = join(workspace, "config.json");
    await writeFile(userConfig, JSON.stringify({
      mcpServers: {
        broken: { command: join(workspace, "missing-mcp-server") },
      },
    }));
    const provider = new MockProvider([{
      events: [
        { type: "text_delta", delta: "completed without the unavailable extension" },
        { type: "response_completed", finishReason: "stop" },
      ],
    }]);

    const exitCode = await runHeadlessCli([
      "--print", "continue",
      "--provider", "openai",
      "--model", "offline",
      "--output-format", "json",
      "--session-dir", join(workspace, "sessions"),
    ], {
      OPENAI_API_KEY: "not-used",
      AGENT_CODE_USER_CONFIG: userConfig,
    }, {
      cwd: workspace,
      io: output.io,
      createProvider: () => provider,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      type: "batch_result",
      exitCode: 0,
    });
    expect(output.stderr.join("")).toContain("MCP server broken unavailable");
  });

  it("denies interactive permission requests safely through the complete runtime", async () => {
    const workspace = await temporaryDirectory();
    const output = memoryIO("");
    const provider = new MockProvider([
      {
        events: [
          {
            type: "tool_call",
            call: {
              type: "tool_call",
              id: "read-1",
              name: "read_file",
              input: { path: "README.md" },
            },
          },
          { type: "response_completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "text_delta", delta: "Permission was denied safely." },
          { type: "response_completed", finishReason: "stop" },
        ],
      },
    ]);

    const exitCode = await runHeadlessCli([
      "--print", "read the file",
      "--provider", "openai",
      "--model", "offline",
      "--output-format", "json",
      "--session-dir", join(workspace, "sessions"),
    ], offlineEnvironment(workspace), {
      cwd: workspace,
      io: output.io,
      createProvider: () => provider,
    });

    const batch = JSON.parse(output.stdout.join("")) as {
      results: Array<{
        exitCode: number;
        permissionDenials: Array<{ toolName: string; reason: string }>;
      }>;
    };
    expect(exitCode).toBe(4);
    expect(batch.results[0]?.exitCode).toBe(4);
    expect(batch.results[0]?.permissionDenials[0]?.toolName).toBe("read_file");
    expect(batch.results[0]?.permissionDenials[0]?.reason)
      .toContain("No interactive permission handler is available");
    expect(output.stderr.join("")).toContain("permission policy");
    expect(provider.requests).toHaveLength(2);
  });

  it("cancels a live provider turn with exit code 130", async () => {
    const workspace = await temporaryDirectory();
    const output = memoryIO("");
    const controller = new AbortController();
    const provider = new MockProvider([
      () => {
        setTimeout(() => controller.abort(new Error("test cancellation")), 0);
        return { events: [{ type: "wait_for_abort" }] };
      },
    ]);
    const pending = runHeadlessCli([
      "--print", "wait",
      "--provider", "openai",
      "--model", "offline",
      "--output-format", "json",
      "--session-dir", join(workspace, "sessions"),
    ], offlineEnvironment(workspace), {
      cwd: workspace,
      io: output.io,
      signal: controller.signal,
      createProvider: () => provider,
    });

    const exitCode = await pending;

    expect(exitCode).toBe(130);
    expect(output.stderr.join("")).toContain("cancelled");
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({ exitCode: 130 });
  });
});

function fakeSession(options: {
  readonly reason?: TurnFinishReason;
  readonly extraEvents?: readonly RuntimeEvent[];
} = {}): {
  readonly value: HeadlessSession;
  readonly persisted: Transcript[];
  readonly events: RuntimeEvent[];
} {
  const persisted: Transcript[] = [];
  const events: RuntimeEvent[] = [];
  let turn = 0;
  const value: HeadlessSession = {
    sessionId: "session-test",
    initialTranscript: createTranscript(),
    async persistTranscript(transcript) {
      persisted.push(structuredClone(transcript));
    },
    async appendRuntimeEvent(event) {
      events.push(event);
    },
    async runTurn({ transcript, emit }): Promise<RunTurnResult> {
      const turnId = `turn-${turn}`;
      turn += 1;
      const prompt = transcript.messages.at(-1)?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
      await emit({
        ...eventBase(turnId, 0),
        type: "turn_started",
      });
      for (const event of options.extraEvents ?? []) await emit({
        ...event,
        turnId,
      });
      await emit({
        ...eventBase(turnId, 1),
        type: "text_delta",
        delta: `answer: ${prompt}`,
      });
      const reason = options.reason ?? "completed";
      await emit({
        ...eventBase(turnId, 2),
        type: "turn_finished",
        reason,
        tests: testsNotRun,
      });
      return {
        transcript: {
          ...transcript,
          messages: [
            ...transcript.messages,
            {
              id: `assistant-${turn}`,
              role: "assistant",
              content: [{ type: "text", text: `answer: ${prompt}` }],
              createdAt: fixedNow().toISOString(),
            },
          ],
        },
        reason,
        steps: 1,
        turnId,
        tests: testsNotRun,
      };
    },
  };
  return { value, persisted, events };
}

function eventBase(
  turnId: string,
  sequence: number,
): {
  readonly protocolVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
  readonly turnId: string;
} {
  return {
    protocolVersion: 1,
    sequence,
    timestamp: fixedNow().toISOString(),
    turnId,
  };
}

function permissionDeniedEvent(): Extract<RuntimeEvent, { type: "permission_decided" }> {
  return {
    protocolVersion: 1,
    type: "permission_decided",
    sequence: 1,
    timestamp: fixedNow().toISOString(),
    turnId: "placeholder",
    requestId: "permission-1",
    toolCallId: "tool-1",
    toolName: "read_file",
    decision: "deny",
    reason: "No interactive permission handler is available; denied safely.",
  };
}

function errorEvent(
  category: Extract<RuntimeEvent, { type: "error" }>["category"],
  message: string,
): Extract<RuntimeEvent, { type: "error" }> {
  return {
    protocolVersion: 1,
    type: "error",
    sequence: 1,
    timestamp: fixedNow().toISOString(),
    turnId: "placeholder",
    category,
    message,
    retryable: false,
  };
}

function memoryIO(input: string): {
  readonly io: HeadlessIO;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
    stdout,
    stderr,
  };
}

function fixedNow(): Date {
  return new Date("2026-07-23T00:00:00.000Z");
}

function incrementalIds(): () => string {
  let id = 0;
  return () => {
    id += 1;
    return `id-${id}`;
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-code-headless-"));
  temporaryDirectories.push(path);
  return path;
}

function offlineEnvironment(workspace: string): NodeJS.ProcessEnv {
  return {
    OPENAI_API_KEY: "not-used",
    AGENT_CODE_USER_CONFIG: join(workspace, "missing-user-config.json"),
  };
}
