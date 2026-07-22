import type { JsonObject, JsonValue } from "../../protocol/json.js";
import type { Tool, ToolHandlerOutput } from "../tool.js";
import {
  ProcessManager,
  type JobSnapshot,
  type ProcessManagerOptions,
} from "./process-manager.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellTools {
  readonly tools: readonly Tool[];
  readonly processManager: ProcessManager;
  readonly warning?: string | undefined;
}

export async function createShellTools(options: ProcessManagerOptions): Promise<ShellTools> {
  const manager = await ProcessManager.create(options);
  const warning = manager.sandboxStatus.warning;
  return {
    processManager: manager,
    ...(warning === undefined ? {} : { warning }),
    tools: Object.freeze([
      createRunShellTool(manager),
      createStartJobTool(manager),
      createReadJobTool(manager),
      createStopJobTool(manager),
    ]),
  };
}

function createRunShellTool(manager: ProcessManager): Tool {
  return {
    definition: {
      name: "run_shell",
      description: "Run one complete shell command in the workspace and wait for it. The whole command may execute processes and access the network; no prefix is treated as safe.",
      inputSchema: commandSchema(),
    },
    sideEffects: ["execute_process", "network"],
    async handler(input, context) {
      const completed = await manager.run({
        command: stringValue(input, "command"),
        cwd: stringValue(input, "cwd", "."),
        timeoutMs: numberValue(input, "timeoutMs", DEFAULT_TIMEOUT_MS),
        signal: context.signal,
      });
      const snapshot = manager.readJob(completed.jobId, undefined, outputBudget(context.maxOutputBytes));
      return formatSnapshot(snapshot, manager);
    },
  };
}

function createStartJobTool(manager: ProcessManager): Tool {
  return {
    definition: {
      name: "start_job",
      description: "Start one complete shell command as a background job. It uses the same process manager and timeout rules as run_shell.",
      inputSchema: commandSchema(),
    },
    sideEffects: ["execute_process", "network"],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const snapshot = await manager.startJob({
        command: stringValue(input, "command"),
        cwd: stringValue(input, "cwd", "."),
        timeoutMs: numberValue(input, "timeoutMs", DEFAULT_TIMEOUT_MS),
      }, context.signal);
      return formatSnapshot(
        manager.readJob(snapshot.jobId, undefined, outputBudget(context.maxOutputBytes)),
        manager,
      );
    },
  };
}

function createReadJobTool(manager: ProcessManager): Tool {
  return {
    definition: {
      name: "read_job",
      description: "Read bounded output and status for a foreground or background job. Pass nextCursor to continue; cleanup removes a completed job after its final page.",
      inputSchema: objectSchema({
        jobId: { type: "string", minLength: 1, maxLength: 128 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
        cleanup: { type: "boolean", default: false },
      }, ["jobId"]),
    },
    sideEffects: [],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const jobId = stringValue(input, "jobId");
      const snapshot = manager.readJob(
        jobId,
        optionalString(input, "cursor"),
        outputBudget(context.maxOutputBytes),
      );
      if (booleanValue(input, "cleanup", false)) {
        if (snapshot.status === "running") throw new Error("Cannot clean up a running job; stop it first");
        if (snapshot.nextCursor !== undefined) throw new Error("Read the remaining output before cleanup");
        manager.cleanupFinished(jobId);
      }
      return formatSnapshot(snapshot, manager, booleanValue(input, "cleanup", false));
    },
  };
}

function createStopJobTool(manager: ProcessManager): Tool {
  return {
    definition: {
      name: "stop_job",
      description: "Stop a background or retained foreground job and wait for process-tree termination.",
      inputSchema: objectSchema({
        jobId: { type: "string", minLength: 1, maxLength: 128 },
      }, ["jobId"]),
    },
    sideEffects: ["execute_process"],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const stopped = await manager.stopJob(stringValue(input, "jobId"));
      context.signal.throwIfAborted();
      const snapshot = manager.readJob(stopped.jobId, undefined, outputBudget(context.maxOutputBytes));
      return formatSnapshot(snapshot, manager);
    },
  };
}

function formatSnapshot(
  snapshot: JobSnapshot & { readonly nextCursor?: string | undefined },
  manager: ProcessManager,
  cleanedUp = false,
): ToolHandlerOutput {
  const lines = [
    `job: ${snapshot.jobId}`,
    `status: ${snapshot.status}`,
    `cwd: ${snapshot.cwd}`,
    `duration_ms: ${snapshot.durationMs}`,
  ];
  if (snapshot.exitReason !== undefined) lines.push(`exit_reason: ${snapshot.exitReason}`);
  if (snapshot.exitCode !== undefined) lines.push(`exit_code: ${snapshot.exitCode}`);
  if (snapshot.signal !== undefined) lines.push(`signal: ${snapshot.signal}`);
  lines.push(`output_bytes: ${snapshot.output.totalBytes}`);
  if (snapshot.output.omittedBytes > 0) {
    lines.push(`output_retained: ${snapshot.output.retainedBytes} (${snapshot.output.omittedBytes} bytes omitted)`);
  }
  if (manager.sandboxStatus.warning !== undefined) {
    lines.push(`warning: ${manager.sandboxStatus.warning}`);
  }
  if (cleanedUp) lines.push("cleaned_up: true");
  lines.push("", snapshot.output.text || "(no output)");

  return {
    content: lines.join("\n"),
    data: snapshotData(snapshot, manager, cleanedUp),
    ...(snapshot.nextCursor === undefined ? {} : { nextCursor: snapshot.nextCursor }),
  };
}

function snapshotData(
  snapshot: JobSnapshot,
  manager: ProcessManager,
  cleanedUp: boolean,
): JsonValue {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    cwd: snapshot.cwd,
    durationMs: snapshot.durationMs,
    ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
    ...(snapshot.exitReason === undefined ? {} : { exitReason: snapshot.exitReason }),
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    output: {
      totalBytes: snapshot.output.totalBytes,
      retainedBytes: snapshot.output.retainedBytes,
      omittedBytes: snapshot.output.omittedBytes,
    },
    sandbox: {
      enforced: manager.sandboxStatus.enforced,
      network: manager.sandboxStatus.network,
    },
    cleanedUp,
  };
}

function commandSchema(): JsonObject {
  return objectSchema({
    command: { type: "string", minLength: 1, maxLength: 32_768 },
    cwd: { type: "string", maxLength: 4_096, default: "." },
    timeoutMs: { type: "integer", minimum: 1, maximum: 1_800_000, default: DEFAULT_TIMEOUT_MS },
  }, ["command"]);
}

function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function stringValue(input: JsonObject, key: string, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function numberValue(input: JsonObject, key: string, fallback: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== "number") throw new TypeError(`${key} must be a number`);
  return value;
}

function booleanValue(input: JsonObject, key: string, fallback: boolean): boolean {
  const value = input[key] ?? fallback;
  if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return value;
}

function outputBudget(maxOutputBytes: number): number {
  return Math.max(128, maxOutputBytes - 1_024);
}
