import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonObject, JsonValue } from "../protocol/json.js";

export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export interface HookCommand {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly envFrom?: Readonly<Record<string, string>> | undefined;
  /** Exact tool name or `*`; omitted for lifecycle-wide hooks. */
  readonly matcher?: string | undefined;
}

export type HookConfiguration = Readonly<{
  readonly [Event in HookEvent]?: readonly HookCommand[] | undefined;
}>;

export interface HookInvocation {
  readonly protocolVersion: 1;
  readonly event: HookEvent;
  readonly workspaceRoot: string;
  readonly payload: JsonObject;
}

export interface HookExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type HookCommandExecutor = (
  command: HookCommand,
  invocation: HookInvocation,
  signal: AbortSignal,
) => Promise<HookExecutionResult>;

export interface HookRunnerOptions {
  readonly workspaceRoot: string;
  readonly hooks?: HookConfiguration | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly execute?: HookCommandExecutor | undefined;
  readonly diagnostic?: ((message: string) => void) | undefined;
}

export class HookBlockedError extends Error {
  readonly event: HookEvent;

  constructor(event: HookEvent, reason: string, options?: ErrorOptions) {
    super(`Hook ${event} blocked the action: ${reason}`, options);
    this.name = "HookBlockedError";
    this.event = event;
  }
}

/**
 * Hooks are restrictions, never grants. Gate hooks fail closed; notification
 * hooks report failures without rewriting an already determined tool result.
 */
export class HookRunner {
  readonly #workspaceRoot: string;
  readonly #hooks: HookConfiguration;
  readonly #execute: HookCommandExecutor;
  readonly #diagnostic: ((message: string) => void) | undefined;

  constructor(options: HookRunnerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#hooks = options.hooks ?? {};
    this.#execute = options.execute ?? createHookCommandExecutor(
      options.workspaceRoot,
      options.environment ?? process.env,
    );
    this.#diagnostic = options.diagnostic;
  }

  async runGate(
    event: "PreToolUse" | "PermissionRequest",
    payload: JsonObject,
    signal: AbortSignal,
  ): Promise<void> {
    for (const command of this.#matching(event, payload)) {
      let result: HookExecutionResult;
      try {
        result = await this.#execute(command, this.#invocation(event, payload), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new HookBlockedError(event, describeError(error), { cause: error });
      }
      const response = parseResponse(result.stdout);
      if (response.block || result.exitCode !== 0) {
        const reason = response.reason ?? nonEmpty(result.stderr) ??
          `command exited with code ${String(result.exitCode)}`;
        throw new HookBlockedError(event, reason);
      }
    }
  }

  async notify(
    event: Exclude<HookEvent, "PreToolUse" | "PermissionRequest">,
    payload: JsonObject,
    signal: AbortSignal,
  ): Promise<void> {
    for (const command of this.#matching(event, payload)) {
      try {
        const result = await this.#execute(command, this.#invocation(event, payload), signal);
        if (result.exitCode !== 0) {
          this.#diagnostic?.(
            `Hook ${event} failed (${String(result.exitCode)}): ${nonEmpty(result.stderr) ?? "no diagnostic"}`,
          );
        }
      } catch (error) {
        this.#diagnostic?.(`Hook ${event} failed: ${describeError(error)}`);
      }
    }
  }

  #matching(event: HookEvent, payload: JsonObject): readonly HookCommand[] {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
    return (this.#hooks[event] ?? []).filter(
      (hook) => hook.matcher === undefined || hook.matcher === "*" || hook.matcher === toolName,
    );
  }

  #invocation(event: HookEvent, payload: JsonObject): HookInvocation {
    return {
      protocolVersion: 1,
      event,
      workspaceRoot: this.#workspaceRoot,
      payload,
    };
  }
}

export function createHookCommandExecutor(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
): HookCommandExecutor {
  return async (command, invocation, signal) => {
    signal.throwIfAborted();
    const timeoutMs = positiveInteger(command.timeoutMs ?? 10_000, "hook timeoutMs");
    const child = spawn(command.command, [...(command.args ?? [])], {
      cwd: workspaceRoot,
      env: extensionEnvironment(environment, command.envFrom),
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    return await collectChild(child, `${JSON.stringify(invocation)}\n`, timeoutMs, signal);
  };
}

async function collectChild(
  child: ChildProcessWithoutNullStreams,
  input: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HookExecutionResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let totalStdout = 0;
  let totalStderr = 0;
  const maxBytes = 16 * 1024;
  child.stdout.on("data", (chunk: Buffer) => {
    if (totalStdout >= maxBytes) return;
    const bounded = chunk.subarray(0, maxBytes - totalStdout);
    stdout.push(bounded);
    totalStdout += bounded.byteLength;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (totalStderr >= maxBytes) return;
    const bounded = chunk.subarray(0, maxBytes - totalStderr);
    stderr.push(bounded);
    totalStderr += bounded.byteLength;
  });

  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    child.kill("SIGTERM");
    forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
    forceTimer.unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timer.unref();
  const abort = (): void => {
    terminate();
  };
  signal.addEventListener("abort", abort, { once: true });
  child.stdin.end(input);

  try {
    const result = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code }));
    });
    if (signal.aborted) throw abortReason(signal);
    if (timedOut) throw new Error(`Hook timed out after ${timeoutMs} ms`);
    return {
      exitCode: result.code,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    };
  } finally {
    clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    signal.removeEventListener("abort", abort);
  }
}

function extensionEnvironment(
  environment: NodeJS.ProcessEnv,
  envFrom: HookCommand["envFrom"],
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
    "SystemRoot", "ComSpec", "PATHEXT",
  ]) {
    if (environment[name] !== undefined) output[name] = environment[name];
  }
  for (const [target, source] of Object.entries(envFrom ?? {})) {
    const value = environment[source];
    if (value === undefined) throw new Error(`Required environment variable is missing: ${source}`);
    output[target] = value;
  }
  return output;
}

function parseResponse(stdout: string): { readonly block: boolean; readonly reason?: string } {
  if (stdout.trim().length === 0) return { block: false };
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { block: false };
    const record = value as Record<string, unknown>;
    return {
      block: record.block === true,
      ...(typeof record.reason === "string" && record.reason.trim().length > 0
        ? { reason: record.reason.trim() }
        : {}),
    };
  } catch {
    return { block: false };
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonEmpty(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hookPayload(value: Readonly<Record<string, JsonValue>>): JsonObject {
  return structuredClone(value);
}
