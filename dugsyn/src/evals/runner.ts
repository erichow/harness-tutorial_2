import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createTranscript } from "../messages/transcript.js";
import type { TraceSnapshot } from "../observability/trace.js";
import type { Provider } from "../providers/provider.js";
import type { RunTurnResult } from "../runtime/agent.js";
import { CodingAgentRuntime } from "../runtime/coding-agent.js";
import { PermissionEngine } from "../security/permissions.js";
import { WorkspaceTrust } from "../security/trust.js";
import { GitAdapter, type GitStatusEntry } from "../tools/git/adapter.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export interface EvalProviderContext {
  readonly workspaceRoot: string;
  readonly runIndex: number;
}

export interface EvalCommand {
  /** Executable name or absolute path. No shell parses this value or its arguments. */
  readonly file: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface EvalScenario {
  readonly name: string;
  readonly prompt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly provider: (context: EvalProviderContext) => Provider | Promise<Provider>;
  readonly test: EvalCommand;
  readonly expectedChangedFiles?: readonly string[] | undefined;
}

export interface EvalCheck {
  readonly name: "agent_completed" | "tests_passed" | "workspace_changed" | "expected_files_changed";
  readonly passed: boolean;
  readonly detail: string;
}

export interface EvalTestResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EvalRunResult {
  readonly scenario: string;
  readonly runIndex: number;
  readonly success: boolean;
  /** Number of passed scoring checks. */
  readonly passed: number;
  /** Total number of scoring checks. */
  readonly total: number;
  readonly score: number;
  readonly workspaceRoot?: string | undefined;
  readonly agent: Pick<RunTurnResult, "reason" | "steps" | "turnId" | "tests">;
  readonly test: EvalTestResult;
  readonly diff: string;
  readonly gitStatus: readonly GitStatusEntry[];
  readonly changedFiles: readonly string[];
  readonly checks: readonly EvalCheck[];
  readonly trace: TraceSnapshot;
}

export interface EvalReport {
  readonly scenario: string;
  readonly runs: readonly EvalRunResult[];
  /** Passed checks across all repeated runs. */
  readonly passed: number;
  /** Total checks across all repeated runs. */
  readonly total: number;
  /** Fraction of runs that passed every check. */
  readonly successRate: number;
  readonly scoreMean: number;
  /** Population variance of per-run scores. */
  readonly scoreVariance: number;
}

export interface EvalRunnerOptions {
  readonly repeats?: number | undefined;
  readonly temporaryDirectory?: string | undefined;
  readonly preserveWorkspaces?: "never" | "failures" | "always" | undefined;
  readonly now?: (() => number) | undefined;
}

interface AgentExecution {
  readonly result: RunTurnResult;
  readonly trace: TraceSnapshot;
}

/**
 * Runs an Agent against a freshly committed repository, then independently
 * measures the resulting repository with a real process, diff, and Git status.
 */
export class EvalRunner {
  readonly #scenario: EvalScenario;
  readonly #repeats: number;
  readonly #temporaryDirectory: string;
  readonly #preserve: "never" | "failures" | "always";
  readonly #now: () => number;

  constructor(scenario: EvalScenario, options: EvalRunnerOptions = {}) {
    if (scenario.name.trim().length === 0) throw new TypeError("Eval scenario name is required");
    if (scenario.prompt.trim().length === 0) throw new TypeError("Eval scenario prompt is required");
    if (Object.keys(scenario.files).length === 0) {
      throw new TypeError("Eval scenario must contain at least one seed file");
    }
    this.#scenario = scenario;
    this.#repeats = positiveInteger(options.repeats ?? 1, "repeats");
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    this.#preserve = options.preserveWorkspaces ?? "never";
    this.#now = options.now ?? Date.now;
  }

  async run(): Promise<EvalReport> {
    await mkdir(this.#temporaryDirectory, { recursive: true });
    const runs: EvalRunResult[] = [];
    for (let runIndex = 0; runIndex < this.#repeats; runIndex += 1) {
      runs.push(await this.#runOnce(runIndex));
    }
    const passed = runs.reduce((sum, run) => sum + run.passed, 0);
    const total = runs.reduce((sum, run) => sum + run.total, 0);
    const successRate = runs.filter((run) => run.success).length / runs.length;
    const scoreMean = runs.reduce((sum, run) => sum + run.score, 0) / runs.length;
    const scoreVariance = runs.reduce(
      (sum, run) => sum + ((run.score - scoreMean) ** 2),
      0,
    ) / runs.length;
    return Object.freeze({
      scenario: this.#scenario.name,
      runs: Object.freeze(runs),
      passed,
      total,
      successRate,
      scoreMean,
      scoreVariance,
    });
  }

  /**
   * Concrete Agent boundary used by every Eval run. Passing workspaceRoot here
   * is what binds file, Git, shell, and test tools to the temporary repository.
   */
  async runAgent(
    workspaceRoot: string,
    provider: Provider,
    prompt = this.#scenario.prompt,
  ): Promise<AgentExecution> {
    const trust = await WorkspaceTrust.create({
      workspaceRoot,
      trustedRoots: [workspaceRoot],
    });
    const runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot,
      permissions: new PermissionEngine({ trust, defaultDecision: "allow" }),
      observability: { sessionId: `eval:${this.#scenario.name}` },
    });
    let result: RunTurnResult;
    try {
      result = await runtime.runTurn({
        transcript: createTranscript([{
          id: "eval-user",
          role: "user",
          content: [{ type: "text", text: prompt }],
          createdAt: new Date(this.#now()).toISOString(),
        }]),
      });
    } finally {
      await runtime.dispose();
    }
    return Object.freeze({ result, trace: runtime.trace.snapshot() });
  }

  async #runOnce(runIndex: number): Promise<EvalRunResult> {
    const createdRoot = await mkdtemp(join(this.#temporaryDirectory, "dugsyn-eval-"));
    const workspaceRoot = await realpath(createdRoot);
    let shouldPreserve = this.#preserve === "always";
    try {
      await seedRepository(workspaceRoot, this.#scenario.files);
      const provider = await this.#scenario.provider({ workspaceRoot, runIndex });
      const agent = await this.runAgent(workspaceRoot, provider);
      const git = new GitAdapter(workspaceRoot);
      const signal = new AbortController().signal;
      const status = await git.status(signal);
      const [worktreeDiff, stagedDiff] = await Promise.all([
        git.run(["diff", "--no-ext-diff", "--binary"], signal),
        git.run(["diff", "--no-ext-diff", "--binary", "--cached"], signal),
      ]);
      assertGitSuccess("git diff", worktreeDiff);
      assertGitSuccess("git diff --cached", stagedDiff);
      const diff = [
        worktreeDiff.stdout,
        stagedDiff.stdout,
      ].filter((item) => item.length > 0).join("\n");
      const changedFiles = Object.freeze(
        [...new Set(status.flatMap((entry) => [entry.originalPath, entry.path]).filter(
          (path): path is string => path !== undefined,
        ))].sort(),
      );
      // Measure Agent changes before the independent test can create artifacts.
      const test = await runCommand(workspaceRoot, this.#scenario.test, this.#now);
      const checks = scoreRun(agent.result, test, status, diff, this.#scenario.expectedChangedFiles);
      const passed = checks.filter((check) => check.passed).length;
      const total = checks.length;
      const success = passed === total;
      shouldPreserve ||= this.#preserve === "failures" && !success;
      return Object.freeze({
        scenario: this.#scenario.name,
        runIndex,
        success,
        passed,
        total,
        score: passed / total,
        ...(shouldPreserve ? { workspaceRoot } : {}),
        agent: Object.freeze({
          reason: agent.result.reason,
          steps: agent.result.steps,
          turnId: agent.result.turnId,
          tests: agent.result.tests,
        }),
        test,
        diff,
        gitStatus: Object.freeze([...status]),
        changedFiles,
        checks,
        trace: agent.trace,
      });
    } finally {
      if (!shouldPreserve) {
        // createdRoot is the exact path returned by mkdtemp; no user path or glob is removed.
        await rm(createdRoot, { recursive: true, force: true });
      }
    }
  }
}

async function seedRepository(
  workspaceRoot: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = safeFixturePath(workspaceRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const git = new GitAdapter(workspaceRoot);
  const signal = new AbortController().signal;
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "dugsyn Eval"],
    ["config", "user.email", "eval@dugsyn.invalid"],
    ["add", "--all"],
    ["commit", "-m", "eval fixture"],
  ] as const) {
    const result = await git.run(args, signal);
    assertGitSuccess(`git ${args[0] ?? ""}`, result);
  }
}

function safeFixturePath(workspaceRoot: string, path: string): string {
  if (path.length === 0 || isAbsolute(path)) throw new TypeError(`Unsafe Eval fixture path: ${path}`);
  const target = resolve(workspaceRoot, path);
  const fromRoot = relative(workspaceRoot, target);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".git" ||
    fromRoot.startsWith(`.git${sep}`) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError(`Unsafe Eval fixture path: ${path}`);
  }
  return target;
}

function scoreRun(
  agent: RunTurnResult,
  test: EvalTestResult,
  status: readonly GitStatusEntry[],
  diff: string,
  expectedChangedFiles: readonly string[] | undefined,
): readonly EvalCheck[] {
  const changed = new Set(status.flatMap((entry) => [entry.path, entry.originalPath]).filter(
    (path): path is string => path !== undefined,
  ));
  const checks: EvalCheck[] = [
    Object.freeze({
      name: "agent_completed",
      passed: agent.reason === "completed",
      detail: `turn reason: ${agent.reason}`,
    }),
    Object.freeze({
      name: "tests_passed",
      passed: test.passed,
      detail: test.timedOut ? "test timed out" : `test exit code: ${test.exitCode ?? "unavailable"}`,
    }),
    Object.freeze({
      name: "workspace_changed",
      passed: status.length > 0 || diff.length > 0,
      detail: `${status.length} Git status entries; ${Buffer.byteLength(diff, "utf8")} diff bytes`,
    }),
  ];
  if (expectedChangedFiles !== undefined) {
    const missing = expectedChangedFiles.filter((path) => !changed.has(path));
    checks.push(Object.freeze({
      name: "expected_files_changed",
      passed: missing.length === 0,
      detail: missing.length === 0 ? "all expected files changed" : `missing: ${missing.join(", ")}`,
    }));
  }
  return Object.freeze(checks);
}

async function runCommand(
  workspaceRoot: string,
  command: EvalCommand,
  now: () => number,
): Promise<EvalTestResult> {
  if (command.file.trim().length === 0) throw new TypeError("Eval test executable is required");
  const cwd = command.cwd === undefined
    ? workspaceRoot
    : safeCommandDirectory(workspaceRoot, command.cwd);
  const timeoutMs = positiveInteger(command.timeoutMs ?? DEFAULT_TIMEOUT_MS, "test timeoutMs");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const startedAt = now();
  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolveResult) => {
      execFile(command.file, [...(command.args ?? [])], {
        cwd,
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
        signal: controller.signal,
        env: commandEnvironment(command.environment),
      }, (error, stdout, stderr) => {
        const exitCode = error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
          ? error.code
          : error === null
            ? 0
            : null;
        resolveResult({
          stdout,
          stderr,
          exitCode,
          timedOut: controller.signal.aborted,
        });
      });
    });
    return Object.freeze({
      passed: !result.timedOut && result.exitCode === 0,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Math.max(0, now() - startedAt),
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeCommandDirectory(workspaceRoot: string, cwd: string): string {
  if (isAbsolute(cwd)) throw new TypeError("Eval test cwd must be workspace-relative");
  const target = resolve(workspaceRoot, cwd);
  const fromRoot = relative(workspaceRoot, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError("Eval test cwd escapes the workspace");
  }
  return target;
}

function commandEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return { ...result, ...additions };
}

function assertGitSuccess(
  operation: string,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
): void {
  if (result.exitCode === 0) return;
  throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
