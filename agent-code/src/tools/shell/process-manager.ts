import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { BoundedProcessOutput, type OutputPage } from "./output.js";
import {
  HostSandboxRunner,
  type SandboxRunner,
  type SandboxStatus,
} from "./sandbox-runner.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CAPTURE_BYTES = 1_048_576;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_MAX_RETAINED_JOBS = 64;
const DEFAULT_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
]);

export type ProcessExitReason =
  | "exit"
  | "signal"
  | "timeout"
  | "cancelled"
  | "stopped"
  | "spawn_error";

export interface ProcessManagerOptions {
  readonly workspaceRoot: string;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly environmentAllowlist?: readonly string[] | undefined;
  readonly maxCaptureBytes?: number | undefined;
  readonly terminationGraceMs?: number | undefined;
  readonly maxRetainedJobs?: number | undefined;
  readonly runner?: SandboxRunner | undefined;
}

export interface ProcessStartOptions {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface JobSnapshot {
  readonly jobId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: "running" | "exited";
  readonly pid?: number | undefined;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
  readonly durationMs: number;
  readonly exitReason?: ProcessExitReason | undefined;
  readonly exitCode?: number | undefined;
  readonly signal?: NodeJS.Signals | undefined;
  readonly error?: string | undefined;
  readonly output: OutputPage;
}

export interface JobStreamOutput {
  readonly stdout: OutputPage;
  readonly stderr: OutputPage;
}

interface ProcessRecord {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: Date;
  readonly output: BoundedProcessOutput;
  readonly stdout: BoundedProcessOutput;
  readonly stderr: BoundedProcessOutput;
  readonly child: ReturnType<SandboxRunner["spawn"]>;
  readonly completion: Promise<void>;
  resolveCompletion(): void;
  timeout?: NodeJS.Timeout | undefined;
  detachAbort?: (() => void) | undefined;
  finishedAt?: Date | undefined;
  exitReason?: ProcessExitReason | undefined;
  exitCode?: number | undefined;
  signal?: NodeJS.Signals | undefined;
  error?: string | undefined;
  requestedExit?: "timeout" | "cancelled" | "stopped" | undefined;
  termination?: Promise<void> | undefined;
}

export class ProcessManager {
  readonly workspaceRoot: string;
  readonly sandboxStatus: SandboxStatus;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #maxCaptureBytes: number;
  readonly #terminationGraceMs: number;
  readonly #maxRetainedJobs: number;
  readonly #runner: SandboxRunner;
  readonly #jobs = new Map<string, ProcessRecord>();
  #disposed = false;

  private constructor(workspaceRoot: string, options: ProcessManagerOptions) {
    this.workspaceRoot = workspaceRoot;
    this.#runner = options.runner ?? new HostSandboxRunner();
    this.sandboxStatus = Object.freeze({ ...this.#runner.status });
    this.#maxCaptureBytes = positiveInteger(
      options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES,
      "maxCaptureBytes",
      2,
    );
    this.#terminationGraceMs = nonNegativeInteger(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    );
    this.#maxRetainedJobs = positiveInteger(
      options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS,
      "maxRetainedJobs",
    );
    this.#environment = buildEnvironment(
      process.env,
      options.environmentAllowlist ?? DEFAULT_ENVIRONMENT_ALLOWLIST,
      options.environment ?? {},
    );
  }

  static async create(options: ProcessManagerOptions): Promise<ProcessManager> {
    const root = await realpath(options.workspaceRoot);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("workspaceRoot must be a directory");
    return new ProcessManager(root, options);
  }

  async run(options: ProcessStartOptions): Promise<JobSnapshot> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const record = await this.#spawn(options, signal);
    await record.completion;
    await record.termination;
    if (signal?.aborted === true) throw abortReason(signal);
    return this.#snapshot(record, 0, 16 * 1_024);
  }

  async startJob(
    options: Omit<ProcessStartOptions, "signal">,
    startupSignal?: AbortSignal,
  ): Promise<JobSnapshot> {
    startupSignal?.throwIfAborted();
    const record = await this.#spawn(options);
    if (startupSignal?.aborted === true) {
      record.requestedExit = "cancelled";
      await this.#terminate(record);
      await record.completion;
      throw abortReason(startupSignal);
    }
    return this.#snapshot(record, 0, 16 * 1_024);
  }

  readJob(jobId: string, cursor: string | undefined, maxOutputBytes: number): JobSnapshot & {
    readonly nextCursor?: string | undefined;
  } {
    const record = this.#requireJob(jobId);
    const offset = decodeOutputCursor(cursor, jobId);
    const snapshot = this.#snapshot(record, offset, maxOutputBytes);
    const nextOffset = snapshot.output.nextOffset ??
      (snapshot.status === "running" ? snapshot.output.totalBytes : undefined);
    return {
      ...snapshot,
      ...(nextOffset === undefined ? {} : { nextCursor: encodeOutputCursor(jobId, nextOffset) }),
    };
  }

  /** Read stdout and stderr independently so test diagnostics never lose their origin. */
  readJobStreams(jobId: string, maxOutputBytes: number): JobStreamOutput {
    const record = this.#requireJob(jobId);
    const budget = Math.max(128, maxOutputBytes);
    return {
      stdout: record.stdout.page(0, budget),
      stderr: record.stderr.page(0, budget),
    };
  }

  async stopJob(jobId: string): Promise<JobSnapshot> {
    const record = this.#requireJob(jobId);
    if (record.finishedAt === undefined) {
      record.requestedExit = "stopped";
      await this.#terminate(record);
      await record.completion;
    }
    return this.#snapshot(record, 0, 16 * 1_024);
  }

  cleanupFinished(jobId?: string): number {
    if (jobId !== undefined) {
      const record = this.#requireJob(jobId);
      if (record.finishedAt === undefined) throw new Error(`Job ${jobId} is still running`);
      this.#jobs.delete(jobId);
      return 1;
    }
    let removed = 0;
    for (const [id, record] of this.#jobs) {
      if (record.finishedAt !== undefined) {
        this.#jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const running = [...this.#jobs.values()].filter((record) => record.finishedAt === undefined);
    await Promise.all(running.map(async (record) => {
      record.requestedExit = "stopped";
      await this.#terminate(record);
      await record.completion;
    }));
    this.#jobs.clear();
  }

  async #spawn(options: ProcessStartOptions, cancellation?: AbortSignal): Promise<ProcessRecord> {
    if (this.#disposed) throw new Error("ProcessManager is disposed");
    const command = options.command.trim();
    if (command.length === 0) throw new Error("command must not be empty");
    const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    const cwd = await this.#resolveCwd(options.cwd ?? ".");
    cancellation?.throwIfAborted();
    this.#evictFinishedJobs();

    const child = this.#runner.spawn({ command, cwd, env: this.#environment });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    const record: ProcessRecord = {
      id: randomUUID(),
      command,
      cwd: displayRelative(this.workspaceRoot, cwd),
      startedAt: new Date(),
      output: new BoundedProcessOutput(this.#maxCaptureBytes),
      stdout: new BoundedProcessOutput(this.#maxCaptureBytes),
      stderr: new BoundedProcessOutput(this.#maxCaptureBytes),
      child,
      completion,
      resolveCompletion,
    };
    this.#jobs.set(record.id, record);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.output.append("stdout", bytes);
      record.stdout.append("stdout", bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.output.append("stderr", bytes);
      record.stderr.append("stderr", bytes);
    });
    child.once("error", (error) => {
      record.error = error.message;
      this.#finalize(record, null, null, "spawn_error");
    });
    child.once("close", (code, signal) => {
      this.#finalize(record, code, signal, code === null ? "signal" : "exit");
    });

    record.timeout = setTimeout(() => {
      if (record.finishedAt !== undefined) return;
      record.requestedExit = "timeout";
      void this.#terminate(record);
    }, timeoutMs);
    record.timeout.unref();

    if (cancellation !== undefined) {
      const onAbort = (): void => {
        if (record.finishedAt !== undefined) return;
        record.requestedExit = "cancelled";
        void this.#terminate(record);
      };
      cancellation.addEventListener("abort", onAbort, { once: true });
      record.detachAbort = () => cancellation.removeEventListener("abort", onAbort);
    }
    return record;
  }

  #finalize(
    record: ProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
    fallbackReason: ProcessExitReason,
  ): void {
    if (record.finishedAt !== undefined) return;
    record.finishedAt = new Date();
    record.exitReason = record.requestedExit ?? fallbackReason;
    if (code !== null) record.exitCode = code;
    if (signal !== null) record.signal = signal;
    if (record.timeout !== undefined) clearTimeout(record.timeout);
    record.detachAbort?.();
    // A shell may exit while a descendant remains. On POSIX, clean the now
    // orphaned members of its dedicated process group as a best effort.
    if (process.platform !== "win32") signalProcessGroup(record.child.pid, "SIGTERM");
    record.resolveCompletion();
  }

  async #terminate(record: ProcessRecord): Promise<void> {
    if (record.termination !== undefined) return await record.termination;
    if (record.finishedAt !== undefined) return;
    record.termination = (async () => {
      await killProcessTree(record.child.pid, "SIGTERM");
      await waitFor(this.#terminationGraceMs);
      // The leader may already be closed while a descendant that ignored TERM
      // remains in the dedicated group. Always perform the final group sweep.
      await killProcessTree(record.child.pid, "SIGKILL");
    })();
    return await record.termination;
  }

  #snapshot(record: ProcessRecord, offset: number, maxOutputBytes: number): JobSnapshot {
    const finishedAt = record.finishedAt;
    return {
      jobId: record.id,
      command: record.command,
      cwd: record.cwd,
      status: finishedAt === undefined ? "running" : "exited",
      ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
      startedAt: record.startedAt.toISOString(),
      ...(finishedAt === undefined ? {} : { finishedAt: finishedAt.toISOString() }),
      durationMs: Math.max(0, (finishedAt ?? new Date()).getTime() - record.startedAt.getTime()),
      ...(record.exitReason === undefined ? {} : { exitReason: record.exitReason }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.error === undefined ? {} : { error: record.error }),
      output: record.output.page(offset, Math.max(128, maxOutputBytes)),
    };
  }

  #requireJob(jobId: string): ProcessRecord {
    const record = this.#jobs.get(jobId);
    if (record === undefined) throw new Error(`Unknown job: ${jobId}`);
    return record;
  }

  #evictFinishedJobs(): void {
    if (this.#jobs.size < this.#maxRetainedJobs) return;
    for (const [id, record] of this.#jobs) {
      if (record.finishedAt !== undefined) {
        this.#jobs.delete(id);
        if (this.#jobs.size < this.#maxRetainedJobs) return;
      }
    }
    if (this.#jobs.size >= this.#maxRetainedJobs) {
      throw new Error(`Too many running jobs (limit: ${this.#maxRetainedJobs})`);
    }
  }

  async #resolveCwd(input: string): Promise<string> {
    if (
      input.includes("\0") ||
      input.includes("\\") ||
      isAbsolute(input) ||
      /^[A-Za-z]:\//u.test(input)
    ) {
      throw new Error("cwd must be a workspace-relative path using forward slashes");
    }
    const lexical = resolve(this.workspaceRoot, input);
    assertWithin(this.workspaceRoot, lexical);
    const canonical = await realpath(lexical);
    assertWithin(this.workspaceRoot, canonical);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("cwd must be a directory");
    return canonical;
  }
}

function buildEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (name.length === 0 || name.includes("=") || name.includes("\0")) {
      throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
    }
    if (value.includes("\0")) throw new Error(`Environment variable ${name} contains NUL`);
    result[name] = value;
  }
  return result;
}

async function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    if (!signalProcessGroup(pid, signal)) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
      }
    }
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const killer = spawnChild("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolvePromise());
    killer.once("close", () => resolvePromise());
  });
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
    return false;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Command cancelled");
}

function assertWithin(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("cwd escapes the workspace root");
}

function displayRelative(root: string, cwd: string): string {
  const path = relative(root, cwd).split(sep).join("/");
  return path || ".";
}

function encodeOutputCursor(jobId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, jobId, offset }), "utf8").toString("base64url");
}

function decodeOutputCursor(cursor: string | undefined, jobId: string): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object" || value === null ||
      (value as { version?: unknown }).version !== 1 ||
      (value as { jobId?: unknown }).jobId !== jobId ||
      !Number.isSafeInteger((value as { offset?: unknown }).offset) ||
      ((value as { offset: number }).offset < 0)
    ) {
      throw new Error();
    }
    return (value as { offset: number }).offset;
  } catch {
    throw new Error("Invalid or stale output cursor");
  }
}

function positiveInteger(value: number, name: string, minimum = 1): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

async function waitFor(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
