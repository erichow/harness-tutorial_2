import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../../protocol/json.js";
import type { ActiveOwnedFile, WorkspaceCheckpointManager } from "../files/checkpoint.js";
import { WorkspacePathGuard } from "../files/path-guard.js";
import { WorkspaceFilePolicy } from "../files/policy.js";
import { sha256 } from "../files/text.js";
import type { Tool } from "../tool.js";
import { GitAdapter, gitError, parseNameStatus, type GitStatusEntry } from "./adapter.js";

interface PreparedCommit {
  readonly token: string;
  readonly head: string | null;
  readonly tree: string;
  readonly paths: readonly string[];
  readonly versions: ReadonlyMap<string, ActiveOwnedFile["version"]>;
  readonly diff: string;
}

export interface GitToolsOptions {
  readonly workspaceRoot: string;
  readonly checkpoints: WorkspaceCheckpointManager;
}

export async function createGitTools(options: GitToolsOptions): Promise<readonly Tool[]> {
  const guard = await WorkspacePathGuard.create(options.workspaceRoot, new WorkspaceFilePolicy());
  const adapter = new GitAdapter(guard.root);
  let prepared: PreparedCommit | undefined;

  const requireNoStagedChanges = async (signal: AbortSignal): Promise<void> => {
    const staged = (await adapter.status(signal)).filter(isStaged);
    if (staged.length > 0) {
      throw new Error(`Safe commit refused because the user already has staged changes: ${staged.map((item) => item.path).join(", ")}`);
    }
  };

  const ownedSelection = async (requested: readonly string[]): Promise<readonly ActiveOwnedFile[]> => {
    const active = new Map(options.checkpoints.activeOwnedFiles().map((file) => [file.path, file]));
    if (active.size === 0) throw new Error("No file-tool changes belong to the running Agent turn");
    const normalized = [...new Set(requested.map((path) => guard.normalize(path)))].sort();
    if (normalized.length === 0) throw new Error("At least one explicit path is required");
    return Object.freeze(normalized.map((path) => {
      const file = active.get(path);
      if (file === undefined) throw new Error(`Path is not owned by the running Agent turn: ${path}`);
      if (!file.chainIntact) throw new Error(`Ownership chain is broken for ${path}`);
      return file;
    }));
  };

  const verifyVersions = async (files: readonly ActiveOwnedFile[]): Promise<void> => {
    for (const file of files) {
      const target = await guard.resolveForWrite(file.path);
      if (file.version === null) {
        if (target.exists) throw new Error(`${file.path} no longer matches the Agent-owned deletion`);
        continue;
      }
      if (!target.exists) throw new Error(`${file.path} no longer exists`);
      const metadata = await lstat(target.lexicalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${file.path} is not a regular file`);
      const actual = { hash: sha256(await readFile(target.lexicalPath)), mode: metadata.mode & 0o777 };
      if (actual.hash !== file.version.hash || actual.mode !== file.version.mode) {
        throw new Error(`${file.path} no longer matches the version written by the Agent`);
      }
    }
  };

  const prepareCommit = async (paths: readonly string[], signal: AbortSignal): Promise<PreparedCommit> => {
    await adapter.assertWorkspaceRepository(signal);
    await requireNoStagedChanges(signal);
    const files = await ownedSelection(paths);
    await verifyVersions(files);
    const head = await adapter.head(signal);
    const directory = await mkdtemp(join(tmpdir(), "dugsyn-git-index-"));
    try {
      const index = join(directory, "index");
      const env = { ...process.env, GIT_INDEX_FILE: index };
      const seed = await adapter.run(head === null ? ["read-tree", "--empty"] : ["read-tree", head], signal, { env });
      if (seed.exitCode !== 0) throw gitError("Could not create temporary Git index", seed);
      const selectedPaths = files.map((file) => file.path);
      const add = await adapter.run(["add", "--", ...selectedPaths], signal, { env });
      if (add.exitCode !== 0) throw gitError("Could not stage Agent-owned paths in the temporary index", add);
      const treeResult = await adapter.run(["write-tree"], signal, { env });
      if (treeResult.exitCode !== 0) throw gitError("Could not create the proposed tree", treeResult);
      const diffResult = await adapter.run(
        ["diff", "--cached", "--no-ext-diff", "--binary", "--", ...selectedPaths],
        signal,
        { env },
      );
      if (diffResult.exitCode !== 0) throw gitError("Could not preview the proposed commit", diffResult);
      if (diffResult.stdout.length === 0) throw new Error("Selected Agent-owned paths produce an empty commit");
      return Object.freeze({
        token: randomUUID(),
        head,
        tree: treeResult.stdout.trim(),
        paths: Object.freeze(selectedPaths),
        versions: new Map(files.map((file) => [file.path, file.version])),
        diff: diffResult.stdout,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const tools: Tool[] = [
    {
      definition: {
        name: "git_status",
        description: "Return structured staged, unstaged, and untracked Git status without changing the repository.",
        inputSchema: objectSchema({}),
      },
      sideEffects: ["read_workspace", "execute_process"],
      async handler(_input, context) {
        const entries = await adapter.status(context.signal);
        return {
          content: entries.length === 0
            ? "Git status: clean"
            : entries.map((entry) => `${entry.index}${entry.worktree} ${entry.path}${entry.originalPath === undefined ? "" : ` <- ${entry.originalPath}`}`).join("\n"),
          data: { clean: entries.length === 0, entries: entries.map(statusData) },
        };
      },
    },
    {
      definition: {
        name: "git_diff",
        description: "Read a bounded Git patch for either unstaged worktree changes or staged index changes.",
        inputSchema: objectSchema({
          mode: { type: "string", enum: ["worktree", "staged"], default: "worktree" },
          paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 4_096 }, maxItems: 100, default: [] },
        }),
      },
      sideEffects: ["read_workspace", "execute_process"],
      async handler(input, context) {
        await adapter.assertWorkspaceRepository(context.signal);
        const mode = stringValue(input, "mode", "worktree");
        const paths = arrayValue(input, "paths").map((path) => guard.normalize(path));
        const args = ["diff", "--no-ext-diff", "--binary", ...(mode === "staged" ? ["--cached"] : []), "--", ...paths];
        const result = await adapter.run(args, context.signal);
        if (result.exitCode !== 0) throw gitError("git diff failed", result);
        const names = await adapter.run(
          ["diff", "--name-status", "-z", ...(mode === "staged" ? ["--cached"] : []), "--", ...paths],
          context.signal,
        );
        if (names.exitCode !== 0) throw gitError("git diff name-status failed", names);
        const files = parseNameStatus(names.stdout);
        return {
          content: result.stdout || `(no ${mode} diff)`,
          data: {
            mode,
            paths,
            empty: result.stdout.length === 0,
            files: files.map((file) => ({
              status: file.status,
              path: file.path,
              ...(file.originalPath === undefined ? {} : { originalPath: file.originalPath }),
            })),
          },
        };
      },
    },
    {
      definition: {
        name: "git_log",
        description: "Return recent commits as structured records; it never invokes a pager.",
        inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }),
      },
      sideEffects: ["read_workspace", "execute_process"],
      async handler(input, context) {
        const commits = await adapter.log(numberValue(input, "limit", 20), context.signal);
        return {
          content: commits.length === 0 ? "Git log: no commits" : commits.map((item) => `${item.hash.slice(0, 12)} ${item.authoredAt} ${item.author} ${item.subject}`).join("\n"),
          data: { commits: commits.map((item) => ({
            hash: item.hash,
            parents: [...item.parents],
            author: item.author,
            authoredAt: item.authoredAt,
            subject: item.subject,
          })) },
        };
      },
    },
    {
      definition: {
        name: "git_prepare_commit",
        description: "Preview a commit containing only explicit files owned by the running Agent turn. Uses a temporary index and refuses any pre-existing staged state.",
        inputSchema: objectSchema({
          paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 4_096 }, minItems: 1, maxItems: 100, uniqueItems: true },
        }, ["paths"]),
      },
      sideEffects: ["read_workspace", "write_workspace", "execute_process"],
      async handler(input, context) {
        prepared = undefined;
        const proposal = await prepareCommit(arrayValue(input, "paths"), context.signal);
        const content = `Commit token: ${proposal.token}\nProposed staged diff (real index unchanged):\n${proposal.diff}`;
        if (Buffer.byteLength(content, "utf8") > context.maxOutputBytes) {
          throw new Error("Proposed staged diff exceeds the tool output limit; prepare fewer paths or make smaller changes so the complete diff can be reviewed");
        }
        prepared = proposal;
        return {
          content,
          data: { token: prepared.token, head: prepared.head, tree: prepared.tree, paths: [...prepared.paths], diff: prepared.diff },
        };
      },
    },
    {
      definition: {
        name: "git_commit",
        description: "Commit an unchanged git_prepare_commit proposal. Rechecks HEAD, empty staged state, Agent ownership, file versions, and the exact tree before committing.",
        inputSchema: objectSchema({
          token: { type: "string", minLength: 1, maxLength: 128 },
          message: { type: "string", minLength: 1, maxLength: 1_000 },
        }, ["token", "message"]),
      },
      sideEffects: ["write_workspace", "execute_process"],
      async handler(input, context) {
        const token = stringValue(input, "token");
        const proposal = prepared;
        if (proposal === undefined || proposal.token !== token) throw new Error("Commit token is missing, stale, or already used");
        const message = stringValue(input, "message").trim();
        if (message.length === 0 || message.includes("\0")) throw new Error("Commit message must not be empty or contain NUL");
        await adapter.assertWorkspaceRepository(context.signal);
        if (await adapter.head(context.signal) !== proposal.head) throw new Error("HEAD changed after the commit preview");
        await requireNoStagedChanges(context.signal);
        const files = await ownedSelection(proposal.paths);
        for (const file of files) {
          const expected = proposal.versions.get(file.path);
          if (JSON.stringify(file.version) !== JSON.stringify(expected)) throw new Error(`Agent ownership changed after preview for ${file.path}`);
        }
        await verifyVersions(files);
        let staged = false;
        try {
          const add = await adapter.run(["add", "--", ...proposal.paths], context.signal);
          if (add.exitCode !== 0) throw gitError("Could not stage Agent-owned paths", add);
          staged = true;
          const tree = await adapter.run(["write-tree"], context.signal);
          if (tree.exitCode !== 0) throw gitError("Could not verify staged tree", tree);
          if (tree.stdout.trim() !== proposal.tree) throw new Error("Staged tree differs from the previewed tree");
          const commit = await adapter.run(["commit", "--no-verify", "--no-gpg-sign", "-m", message], context.signal);
          if (commit.exitCode !== 0) throw gitError("git commit failed", commit);
          const hash = await adapter.head(context.signal);
          if (hash === null) throw new Error("Commit succeeded but HEAD is missing");
          prepared = undefined;
          return {
            content: `Committed ${hash}\nPaths: ${proposal.paths.join(", ")}\n\nStaged diff reviewed before commit:\n${proposal.diff}`,
            data: { hash, paths: [...proposal.paths], tree: proposal.tree, diff: proposal.diff },
          };
        } catch (error) {
          const cleanupSignal = new AbortController().signal;
          const currentHead = await adapter.head(cleanupSignal).catch(() => proposal.head);
          if (currentHead !== proposal.head) prepared = undefined;
          else if (staged) await unstage(adapter, proposal.paths, proposal.head, cleanupSignal);
          throw error;
        }
      },
    },
  ];
  return Object.freeze(tools);
}

async function unstage(adapter: GitAdapter, paths: readonly string[], head: string | null, signal: AbortSignal): Promise<void> {
  const args = head === null
    ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]
    : ["restore", "--staged", `--source=${head}`, "--", ...paths];
  await adapter.run(args, signal).catch(() => undefined);
}

function isStaged(entry: GitStatusEntry): boolean {
  return entry.index !== " " && entry.index !== "?" && entry.index !== "!";
}

function statusData(entry: GitStatusEntry): JsonObject {
  return {
    path: entry.path,
    ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
    index: entry.index,
    worktree: entry.worktree,
    kind: entry.kind,
  };
}

function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
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

function arrayValue(input: JsonObject, key: string): string[] {
  const value = input[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${key} must be a string array`);
  return value as string[];
}
