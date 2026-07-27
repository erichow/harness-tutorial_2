import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

import { createTranscript, type Transcript } from "../messages/transcript.js";
import type { Provider } from "../providers/provider.js";
import { CodingAgentRuntime } from "../runtime/coding-agent.js";
import { PermissionEngine } from "../security/permissions.js";
import { WorkspaceTrust } from "../security/trust.js";
import { GitAdapter, gitError, type GitStatusEntry } from "../tools/git/adapter.js";
import { createPlatformSandboxRunner } from "../tools/shell/sandbox-runner.js";
import {
  attenuateSubagentCapabilities,
  type EffectiveSubagentCapabilities,
  type SubagentCapabilityGrant,
} from "./capabilities.js";

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const MAX_TEST_OUTPUT_BYTES = 1_048_576;
const MAX_SUMMARY_CHARS = 8_192;

export interface SubagentTask {
  readonly id: string;
  readonly prompt: string;
  readonly mode: "read" | "write";
  readonly requestedTools: readonly string[];
  /**
   * Repository-relative files or directory prefixes the task owns. Required
   * for write tasks and checked against the actual committed artifact.
   */
  readonly writeScopes?: readonly string[] | undefined;
}

export interface SubagentProviderContext {
  readonly taskId: string;
  readonly workspaceRoot: string;
  readonly capabilities: EffectiveSubagentCapabilities;
}

export interface SubagentArtifactReference {
  readonly baseCommit: string;
  readonly branch: string;
  readonly commit: string;
  readonly changedFiles: readonly string[];
  readonly diffSha256: string;
}

export interface SubagentResult {
  readonly taskId: string;
  readonly mode: "read" | "write";
  readonly status: "completed" | "failed" | "cancelled";
  readonly summary: string;
  readonly capabilities: EffectiveSubagentCapabilities;
  readonly trace: {
    readonly traceId: string;
    readonly sessionId: string;
  };
  readonly artifact?: SubagentArtifactReference | undefined;
  readonly error?: {
    readonly code:
      | "agent_failed"
      | "unexpected_write"
      | "scope_violation"
      | "git_history_changed";
    readonly message: string;
  } | undefined;
}

export interface IntegrationCommand {
  readonly file: string;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface IntegrationTestResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type IntegrationResult =
  | {
      readonly status: "merged";
      readonly baseCommit: string;
      readonly head: string;
      readonly commits: readonly string[];
      readonly test: IntegrationTestResult;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "subagent_failed"
        | "parent_changed"
        | "parent_dirty"
        | "conflict"
        | "tests_failed";
      readonly detail: string;
      readonly test?: IntegrationTestResult | undefined;
    };

export interface SubagentCoordinatorOptions {
  readonly repositoryRoot: string;
  readonly parentGrant: SubagentCapabilityGrant;
  readonly provider: (
    context: SubagentProviderContext,
  ) => Provider | Promise<Provider>;
  readonly temporaryDirectory?: string | undefined;
  readonly createId?: (() => string) | undefined;
}

interface PreparedTask {
  readonly task: SubagentTask;
  readonly capabilities: EffectiveSubagentCapabilities;
  readonly scopes: readonly string[];
  readonly workspaceRoot: string;
  readonly branch: string;
}

interface OwnedWorktree {
  readonly path: string;
  readonly branch?: string | undefined;
}

/**
 * Owns an isolated batch until it is integrated or disposed. Results expose
 * summaries and immutable artifact references, never child Transcripts.
 */
export class SubagentBatch {
  readonly baseCommit: string;
  readonly results: readonly SubagentResult[];
  readonly #repositoryRoot: string;
  readonly #batchRoot: string;
  readonly #worktrees: OwnedWorktree[];
  #disposed = false;

  constructor(options: {
    readonly repositoryRoot: string;
    readonly batchRoot: string;
    readonly baseCommit: string;
    readonly results: readonly SubagentResult[];
    readonly worktrees: readonly OwnedWorktree[];
  }) {
    this.#repositoryRoot = options.repositoryRoot;
    this.#batchRoot = options.batchRoot;
    this.baseCommit = options.baseCommit;
    this.results = Object.freeze([...options.results]);
    this.#worktrees = [...options.worktrees];
  }

  async integrate(
    command: IntegrationCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IntegrationResult> {
    if (this.#disposed) throw new Error("SubagentBatch is disposed");
    signal.throwIfAborted();
    if (this.results.some((result) => result.status !== "completed")) {
      return rejected("subagent_failed", "Every subagent must complete before integration.");
    }
    const artifacts = this.results.flatMap((result) =>
      result.status === "completed" && result.artifact !== undefined ? [result.artifact] : []
    );
    if (artifacts.length !== this.results.filter((result) => result.mode === "write").length) {
      return rejected("subagent_failed", "Every subagent must complete with a validated artifact before integration.");
    }

    const parent = new GitAdapter(this.#repositoryRoot);
    const preflight = await checkParent(parent, this.baseCommit, signal);
    if (preflight !== undefined) return preflight;

    const integrationPath = join(this.#batchRoot, "integration");
    const add = await parent.run(["worktree", "add", "--detach", integrationPath, this.baseCommit], signal);
    if (add.exitCode !== 0) throw gitError("Could not create integration worktree", add);
    this.#worktrees.push({ path: integrationPath });
    const integration = new GitAdapter(await realpath(integrationPath));

    for (const artifact of artifacts) {
      const merged = await integration.run(
        [
          "-c", "user.name=dugsyn Coordinator",
          "-c", "user.email=coordinator@dugsyn.invalid",
          "merge", "--no-ff", "--no-edit", artifact.commit,
        ],
        signal,
      );
      if (merged.exitCode !== 0) {
        await integration.run(["merge", "--abort"], new AbortController().signal).catch(() => undefined);
        return rejected(
          "conflict",
          `Integration conflict while merging task branch ${artifact.branch}.`,
        );
      }
    }

    const test = await runIntegrationCommand(integration.root, command, signal);
    if (!test.passed) {
      return Object.freeze({
        status: "rejected",
        reason: "tests_failed",
        detail: test.timedOut ? "Integration test timed out." : "Integration test returned a non-zero exit code.",
        test,
      });
    }

    const integrationHead = await integration.head(signal);
    if (integrationHead === null) throw new Error("Integration worktree has no HEAD");
    const finalPreflight = await checkParent(parent, this.baseCommit, signal);
    if (finalPreflight !== undefined) return finalPreflight;
    const applied = await parent.run(["merge", "--ff-only", integrationHead], signal);
    if (applied.exitCode !== 0) {
      return rejected("parent_changed", "Parent branch could not be fast-forwarded after validation.");
    }
    return Object.freeze({
      status: "merged",
      baseCommit: this.baseCommit,
      head: integrationHead,
      commits: Object.freeze(artifacts.map((artifact) => artifact.commit)),
      test,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const root = new GitAdapter(this.#repositoryRoot);
    await cleanupOwnedWorktrees(root, this.#batchRoot, this.#worktrees);
  }
}

export class SubagentCoordinator {
  readonly #repositoryRootInput: string;
  readonly #parentGrant: SubagentCapabilityGrant;
  readonly #provider: SubagentCoordinatorOptions["provider"];
  readonly #temporaryDirectory: string;
  readonly #createId: () => string;

  constructor(options: SubagentCoordinatorOptions) {
    this.#repositoryRootInput = options.repositoryRoot;
    this.#parentGrant = options.parentGrant;
    this.#provider = options.provider;
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    this.#createId = options.createId ?? randomUUID;
  }

  async run(
    tasks: readonly SubagentTask[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SubagentBatch> {
    signal.throwIfAborted();
    if (tasks.length === 0) throw new TypeError("At least one subagent task is required");
    const validated = validateTasks(tasks, this.#parentGrant);
    const repositoryRoot = await realpath(this.#repositoryRootInput);
    const repository = new GitAdapter(repositoryRoot);
    await repository.assertWorkspaceRepository(signal);
    const dirty = await repository.status(signal);
    if (dirty.length > 0) throw new Error("Parent worktree must be clean before starting subagents");
    const baseCommit = await repository.head(signal);
    if (baseCommit === null) throw new Error("Subagents require a repository with an initial commit");

    await mkdir(this.#temporaryDirectory, { recursive: true });
    const batchRoot = await mkdtemp(join(this.#temporaryDirectory, "dugsyn-subagents-"));
    const worktrees: OwnedWorktree[] = [];
    try {
      const prepared: PreparedTask[] = [];
      for (const [index, item] of validated.entries()) {
        const workspacePath = join(batchRoot, `task-${index + 1}`);
        const branch = `dugsyn/subagent-${safeRef(this.#createId())}-${index + 1}`;
        const added = await repository.run(
          ["worktree", "add", "-b", branch, workspacePath, baseCommit],
          signal,
        );
        if (added.exitCode !== 0) throw gitError("Could not create subagent worktree", added);
        const workspaceRoot = await realpath(workspacePath);
        worktrees.push({ path: workspaceRoot, branch });
        prepared.push({
          ...item,
          workspaceRoot,
          branch,
        });
      }

      const batchController = new AbortController();
      const batchSignal = AbortSignal.any([signal, batchController.signal]);
      const executions = prepared.map(async (item) => {
        try {
          return await this.#runTask(item, baseCommit, batchSignal);
        } catch (error) {
          if (!batchController.signal.aborted) batchController.abort(error);
          throw error;
        }
      });
      const settled = await Promise.allSettled(executions);
      const failure = settled.find(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
      const results = settled.map((item) => (item as PromiseFulfilledResult<SubagentResult>).value);
      return new SubagentBatch({
        repositoryRoot,
        batchRoot,
        baseCommit,
        results,
        worktrees,
      });
    } catch (error) {
      await cleanupOwnedWorktrees(repository, batchRoot, worktrees);
      throw error;
    }
  }

  async #runTask(
    prepared: PreparedTask,
    baseCommit: string,
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const trust = await WorkspaceTrust.create({
      workspaceRoot: prepared.workspaceRoot,
      trustedRoots: [prepared.workspaceRoot],
    });
    const permissions = new PermissionEngine({
      trust,
      managedRules: [{
        id: "subagent-parent-grant",
        action: "allow",
        tools: prepared.capabilities.tools,
        reason: "Allowed by the attenuated parent-task capability grant.",
      }],
      defaultDecision: "deny",
    });
    const provider = await this.#provider({
      taskId: prepared.task.id,
      workspaceRoot: prepared.workspaceRoot,
      capabilities: prepared.capabilities,
    });
    const runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot: prepared.workspaceRoot,
      permissions,
      tools: { allowedNames: prepared.capabilities.tools },
      shell: {
        runner: createPlatformSandboxRunner({
          workspaceRoot: prepared.workspaceRoot,
          allowNetwork: false,
          fallback: "closed",
        }),
      },
      context: {
        systemPrompt: [
          "You are an isolated subagent.",
          "Work only on the bounded task in the user message.",
          "Do not change Git history; the parent coordinator owns commits and integration.",
          "Return a concise factual summary of work and verification.",
        ].join("\n"),
      },
      observability: { sessionId: `subagent:${prepared.task.id}` },
    });
    let transcript: Transcript;
    let status: SubagentResult["status"];
    let agentReason = "error";
    try {
      const turn = await runtime.runTurn({
        transcript: createTranscript([{
          id: `subagent-task:${prepared.task.id}`,
          role: "user",
          content: [{ type: "text", text: prepared.task.prompt }],
          createdAt: new Date().toISOString(),
        }]),
        signal,
      });
      transcript = turn.transcript;
      agentReason = turn.reason;
      status = turn.reason === "completed"
        ? "completed"
        : turn.reason === "cancelled"
          ? "cancelled"
          : "failed";
    } finally {
      await runtime.dispose();
    }
    const trace = Object.freeze({
      traceId: runtime.trace.traceId,
      sessionId: runtime.trace.sessionId,
    });
    const summary = summarizeTranscript(transcript);
    if (status !== "completed") {
      return Object.freeze({
        taskId: prepared.task.id,
        mode: prepared.task.mode,
        status,
        summary,
        capabilities: prepared.capabilities,
        trace,
        error: Object.freeze({
          code: "agent_failed",
          message: `Subagent turn finished with reason: ${agentReason}`,
        }),
      });
    }

    const git = new GitAdapter(prepared.workspaceRoot);
    const headAfterAgent = await git.head(signal);
    if (headAfterAgent !== baseCommit) {
      return failedArtifact(prepared, summary, trace, "git_history_changed", "Subagent changed Git history.");
    }
    const changes = await git.status(signal);
    const changedFiles = changedPaths(changes);
    if (prepared.task.mode === "read" && changedFiles.length > 0) {
      return failedArtifact(prepared, summary, trace, "unexpected_write", "Read-only subagent modified its worktree.");
    }
    const outsideScope = changedFiles.filter((path) => !withinScopes(path, prepared.scopes));
    if (outsideScope.length > 0) {
      return failedArtifact(
        prepared,
        summary,
        trace,
        "scope_violation",
        `Subagent changed paths outside its declared scopes: ${outsideScope.join(", ")}`,
      );
    }
    if (prepared.task.mode === "read") {
      return Object.freeze({
        taskId: prepared.task.id,
        mode: prepared.task.mode,
        status: "completed",
        summary,
        capabilities: prepared.capabilities,
        trace,
      });
    }
    if (changedFiles.length === 0) {
      return failedArtifact(prepared, summary, trace, "unexpected_write", "Write subagent produced no repository changes.");
    }

    for (const args of [
      ["add", "--all"],
      [
        "-c", "user.name=dugsyn Subagent",
        "-c", "user.email=subagent@dugsyn.invalid",
        "commit", "-m", `dugsyn subagent: ${prepared.task.id}`,
      ],
    ] as const) {
      const result = await git.run(args, signal);
      if (result.exitCode !== 0) throw gitError("Could not commit subagent artifact", result);
    }
    const commit = await git.head(signal);
    if (commit === null) throw new Error("Subagent commit has no HEAD");
    const shown = await git.run(["show", "--format=", "--no-ext-diff", "--binary", commit], signal);
    if (shown.exitCode !== 0) throw gitError("Could not inspect subagent artifact", shown);
    return Object.freeze({
      taskId: prepared.task.id,
      mode: prepared.task.mode,
      status: "completed",
      summary,
      capabilities: prepared.capabilities,
      trace,
      artifact: Object.freeze({
        baseCommit,
        branch: prepared.branch,
        commit,
        changedFiles: Object.freeze(changedFiles),
        diffSha256: createHash("sha256").update(shown.stdout).digest("hex"),
      }),
    });
  }
}

function validateTasks(
  tasks: readonly SubagentTask[],
  parentGrant: SubagentCapabilityGrant,
): readonly Omit<PreparedTask, "workspaceRoot" | "branch">[] {
  const ids = new Set<string>();
  const validated = tasks.map((task) => {
    if (task.id.trim().length === 0) throw new TypeError("Subagent task id is required");
    if (ids.has(task.id)) throw new TypeError(`Duplicate subagent task id: ${task.id}`);
    ids.add(task.id);
    if (task.prompt.trim().length === 0) throw new TypeError(`Subagent task ${task.id} prompt is required`);
    const scopes = Object.freeze((task.writeScopes ?? []).map(normalizeScope));
    if (task.mode === "write" && scopes.length === 0) {
      throw new TypeError(`Write subagent ${task.id} requires at least one write scope`);
    }
    if (task.mode === "read" && scopes.length > 0) {
      throw new TypeError(`Read-only subagent ${task.id} cannot declare write scopes`);
    }
    const normalizedTask: SubagentTask = Object.freeze({
      id: task.id,
      prompt: task.prompt,
      mode: task.mode,
      requestedTools: Object.freeze([...task.requestedTools]),
      ...(scopes.length === 0 ? {} : { writeScopes: scopes }),
    });
    return Object.freeze({
      task: normalizedTask,
      capabilities: attenuateSubagentCapabilities(parentGrant, task.requestedTools, task.mode),
      scopes,
    });
  });
  for (let left = 0; left < validated.length; left += 1) {
    for (let right = left + 1; right < validated.length; right += 1) {
      const leftTask = validated[left];
      const rightTask = validated[right];
      if (
        leftTask !== undefined &&
        rightTask !== undefined &&
        leftTask.scopes.some((a) => rightTask.scopes.some((b) => scopesOverlap(a, b)))
      ) {
        throw new TypeError(
          `Parallel subagent write scopes overlap: ${leftTask.task.id} and ${rightTask.task.id}`,
        );
      }
    }
  }
  return Object.freeze(validated);
}

function normalizeScope(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\0") ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    input.includes("\\")
  ) {
    throw new TypeError(`Unsafe subagent write scope: ${input}`);
  }
  const normalized = posix.normalize(input);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    throw new TypeError(`Unsafe subagent write scope: ${input}`);
  }
  return normalized === "." ? "." : normalized.replace(/\/+$/u, "");
}

function scopesOverlap(left: string, right: string): boolean {
  return left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`);
}

function withinScopes(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) =>
    scope === "." || path === scope || path.startsWith(`${scope}/`)
  );
}

function changedPaths(status: readonly GitStatusEntry[]): string[] {
  return [...new Set(status.flatMap((entry) => [entry.originalPath, entry.path]).filter(
    (path): path is string => path !== undefined,
  ))].sort();
}

function summarizeTranscript(transcript: Transcript): string {
  const assistant = [...transcript.messages].reverse().find((message) => message.role === "assistant");
  if (assistant === undefined) return "Subagent returned no assistant summary.";
  const text = assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
  return (text.trim() || "Subagent returned no textual summary.").slice(0, MAX_SUMMARY_CHARS);
}

function failedArtifact(
  prepared: PreparedTask,
  summary: string,
  trace: SubagentResult["trace"],
  code: NonNullable<SubagentResult["error"]>["code"],
  message: string,
): SubagentResult {
  return Object.freeze({
    taskId: prepared.task.id,
    mode: prepared.task.mode,
    status: "failed",
    summary,
    capabilities: prepared.capabilities,
    trace,
    error: Object.freeze({ code, message }),
  });
}

async function checkParent(
  parent: GitAdapter,
  baseCommit: string,
  signal: AbortSignal,
): Promise<Extract<IntegrationResult, { status: "rejected" }> | undefined> {
  const head = await parent.head(signal);
  if (head !== baseCommit) {
    return rejected("parent_changed", "Parent HEAD changed after the subagent batch started.");
  }
  if ((await parent.status(signal)).length > 0) {
    return rejected("parent_dirty", "Parent worktree has uncommitted changes.");
  }
  return undefined;
}

function rejected(
  reason: Extract<IntegrationResult, { status: "rejected" }>["reason"],
  detail: string,
): Extract<IntegrationResult, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", reason, detail });
}

async function runIntegrationCommand(
  workspaceRoot: string,
  command: IntegrationCommand,
  signal: AbortSignal,
): Promise<IntegrationTestResult> {
  if (command.file.trim().length === 0) throw new TypeError("Integration command file is required");
  const timeoutMs = positiveInteger(command.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, "integration timeoutMs");
  const environment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    ...command.environment,
  };
  return await new Promise((resolveResult, reject) => {
    execFile(command.file, [...(command.args ?? [])], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: MAX_TEST_OUTPUT_BYTES,
      env: environment,
      signal,
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Integration cancelled"));
        return;
      }
      const exitCode = error === null
        ? 0
        : typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
          ? error.code
          : null;
      const timedOut = error !== null &&
        typeof error === "object" &&
        "killed" in error &&
        error.killed === true;
      resolveResult(Object.freeze({
        passed: error === null,
        exitCode,
        timedOut,
        stdout,
        stderr,
      }));
    });
  });
}

function safeRef(input: string): string {
  const safe = input.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (safe || createHash("sha256").update(input).digest("hex").slice(0, 12)).slice(0, 48);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

async function cleanupOwnedWorktrees(
  repository: GitAdapter,
  batchRoot: string,
  worktrees: readonly OwnedWorktree[],
): Promise<void> {
  const signal = new AbortController().signal;
  for (const worktree of [...worktrees].reverse()) {
    await repository.run(["worktree", "remove", "--force", worktree.path], signal).catch(() => undefined);
  }
  // batchRoot is the exact directory returned by mkdtemp and is never user input.
  await rm(batchRoot, { recursive: true, force: true });
  await repository.run(["worktree", "prune"], signal).catch(() => undefined);
  for (const worktree of worktrees) {
    if (worktree.branch !== undefined) {
      await repository.run(["branch", "-D", worktree.branch], signal).catch(() => undefined);
    }
  }
}
