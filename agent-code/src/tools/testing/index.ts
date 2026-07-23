import type { JsonObject, JsonValue } from "../../protocol/json.js";
import type { Tool, ToolHandlerOutput } from "../tool.js";
import type { JobSnapshot, ProcessManager } from "../shell/process-manager.js";
import type { OutputPage } from "../shell/output.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export type TestProcessOutcome =
  | "passed"
  | "failed"
  | "timed_out"
  | "signalled"
  | "spawn_failed";

/** Dedicated foreground test command with a machine-derived verdict. */
export function createTestTools(manager: ProcessManager): readonly Tool[] {
  return Object.freeze([createRunTestsTool(manager)]);
}

function createRunTestsTool(manager: ProcessManager): Tool {
  return {
    definition: {
      name: "run_tests",
      description: "Run a foreground test command. The runtime derives pass/fail from the process exit reason and code, preserves stdout and stderr separately, and enforces turn-local test/repair budgets. Use this instead of run_shell when verifying a change.",
      inputSchema: objectSchema({
        command: { type: "string", minLength: 1, maxLength: 32_768 },
        cwd: { type: "string", maxLength: 4_096, default: "." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 1_800_000, default: DEFAULT_TIMEOUT_MS },
      }, ["command"]),
    },
    sideEffects: ["execute_process", "network"],
    async handler(input, context) {
      const completed = await manager.run({
        command: stringValue(input, "command"),
        cwd: stringValue(input, "cwd", "."),
        timeoutMs: numberValue(input, "timeoutMs", DEFAULT_TIMEOUT_MS),
        signal: context.signal,
      });
      const perStreamBudget = Math.max(128, Math.floor((context.maxOutputBytes - 2_048) / 2));
      const streams = manager.readJobStreams(completed.jobId, perStreamBudget);
      return formatTestResult(completed, streams.stdout, streams.stderr);
    },
  };
}

function formatTestResult(
  snapshot: JobSnapshot,
  stdout: OutputPage,
  stderr: OutputPage,
): ToolHandlerOutput {
  const outcome = processOutcome(snapshot);
  const passed = outcome === "passed";
  const lines = [
    `test_status: ${passed ? "passed" : "failed"}`,
    `outcome: ${outcome}`,
    `cwd: ${snapshot.cwd}`,
    `duration_ms: ${snapshot.durationMs}`,
    ...(snapshot.exitReason === undefined ? [] : [`exit_reason: ${snapshot.exitReason}`]),
    ...(snapshot.exitCode === undefined ? [] : [`exit_code: ${snapshot.exitCode}`]),
    ...(snapshot.signal === undefined ? [] : [`signal: ${snapshot.signal}`]),
    "",
    "stdout:",
    stdout.text || "(empty)",
    "",
    "stderr:",
    stderr.text || "(empty)",
  ];
  const data: JsonValue = {
    testStatus: passed ? "passed" : "failed",
    outcome,
    command: snapshot.command,
    cwd: snapshot.cwd,
    durationMs: snapshot.durationMs,
    ...(snapshot.exitReason === undefined ? {} : { exitReason: snapshot.exitReason }),
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    stdout: {
      totalBytes: stdout.totalBytes,
      retainedBytes: stdout.retainedBytes,
      omittedBytes: stdout.omittedBytes,
      pageTruncated: stdout.nextOffset !== undefined,
      empty: stdout.totalBytes === 0,
    },
    stderr: {
      totalBytes: stderr.totalBytes,
      retainedBytes: stderr.retainedBytes,
      omittedBytes: stderr.omittedBytes,
      pageTruncated: stderr.nextOffset !== undefined,
      empty: stderr.totalBytes === 0,
    },
  };
  return { content: lines.join("\n"), data };
}

function processOutcome(snapshot: JobSnapshot): TestProcessOutcome {
  if (snapshot.exitReason === "exit") {
    return snapshot.exitCode === 0 ? "passed" : "failed";
  }
  if (snapshot.exitReason === "timeout") return "timed_out";
  if (snapshot.exitReason === "spawn_error") return "spawn_failed";
  return "signalled";
}

function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

function stringValue(input: JsonObject, key: string, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function numberValue(input: JsonObject, key: string, fallback: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== "number") throw new TypeError(`${key} must be a number`);
  return value;
}
