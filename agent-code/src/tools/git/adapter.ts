import { execFile } from "node:child_process";

const DEFAULT_MAX_BUFFER = 4 * 1_048_576;

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string | undefined;
  readonly index: string;
  readonly worktree: string;
  readonly kind: "ordinary" | "renamed" | "untracked" | "ignored";
}

export interface GitLogEntry {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export interface GitDiffEntry {
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string | undefined;
}

/** Runs Git with argument arrays only; no command is interpreted by a shell. */
export class GitAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async assertWorkspaceRepository(signal: AbortSignal): Promise<void> {
    const result = await this.run(["rev-parse", "--show-toplevel"], signal);
    if (result.exitCode !== 0) throw gitError("Workspace is not a Git repository", result);
    const top = result.stdout.trim();
    if (top !== this.root) {
      throw new Error(`Git repository root must equal the workspace root (found ${top})`);
    }
  }

  async status(signal: AbortSignal): Promise<readonly GitStatusEntry[]> {
    await this.assertWorkspaceRepository(signal);
    const result = await this.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
      signal,
    );
    if (result.exitCode !== 0) throw gitError("git status failed", result);
    return parsePorcelainV1(result.stdout);
  }

  async head(signal: AbortSignal): Promise<string | null> {
    const result = await this.run(["rev-parse", "--verify", "HEAD"], signal);
    if (result.exitCode === 0) return result.stdout.trim();
    return null;
  }

  async log(limit: number, signal: AbortSignal): Promise<readonly GitLogEntry[]> {
    await this.assertWorkspaceRepository(signal);
    const format = "%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e";
    const result = await this.run(["log", `--max-count=${limit}`, `--format=${format}`], signal);
    if (result.exitCode !== 0) {
      if ((await this.head(signal)) === null) return Object.freeze([]);
      throw gitError("git log failed", result);
    }
    return Object.freeze(result.stdout.split("\x1e").flatMap((record) => {
      const clean = record.replace(/^\n+|\n+$/gu, "");
      if (clean.length === 0) return [];
      const fields = clean.split("\x1f");
      if (fields.length !== 5) throw new Error("Git returned an invalid log record");
      return [Object.freeze({
        hash: fields[0] ?? "",
        parents: Object.freeze((fields[1] ?? "").split(" ").filter(Boolean)),
        author: fields[2] ?? "",
        authoredAt: fields[3] ?? "",
        subject: fields[4] ?? "",
      })];
    }));
  }

  async run(
    args: readonly string[],
    signal: AbortSignal,
    options: { readonly env?: NodeJS.ProcessEnv | undefined; readonly maxBuffer?: number | undefined } = {},
  ): Promise<GitCommandResult> {
    signal.throwIfAborted();
    return await new Promise<GitCommandResult>((resolve, reject) => {
      execFile("git", ["-C", this.root, ...args], {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        signal,
        ...(options.env === undefined ? {} : { env: options.env }),
      }, (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("Git command cancelled"));
          return;
        }
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(error);
      });
    });
  }
}

export function parsePorcelainV1(output: string): readonly GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Git returned invalid status data");
    const indexState = record[0] ?? " ";
    const worktreeState = record[1] ?? " ";
    const path = record.slice(3);
    const renamed = indexState === "R" || indexState === "C" || worktreeState === "R" || worktreeState === "C";
    const originalPath = renamed ? records[index += 1] : undefined;
    if (renamed && !originalPath) throw new Error("Git returned an incomplete rename record");
    entries.push(Object.freeze({
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
      index: indexState,
      worktree: worktreeState,
      kind: indexState === "?" && worktreeState === "?"
        ? "untracked"
        : indexState === "!" && worktreeState === "!"
          ? "ignored"
          : renamed
            ? "renamed"
            : "ordinary",
    }));
  }
  return Object.freeze(entries);
}

export function parseNameStatus(output: string): readonly GitDiffEntry[] {
  const records = output.split("\0");
  const entries: GitDiffEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index] ?? "";
    if (status.length === 0) continue;
    const renamed = status.startsWith("R") || status.startsWith("C");
    const firstPath = records[index += 1];
    if (!firstPath) throw new Error("Git returned incomplete diff name-status data");
    const secondPath = renamed ? records[index += 1] : undefined;
    if (renamed && !secondPath) throw new Error("Git returned an incomplete diff rename record");
    entries.push(Object.freeze({
      status,
      path: secondPath ?? firstPath,
      ...(secondPath === undefined ? {} : { originalPath: firstPath }),
    }));
  }
  return Object.freeze(entries);
}

export function gitError(message: string, result: GitCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`${message}: ${detail}`);
}
