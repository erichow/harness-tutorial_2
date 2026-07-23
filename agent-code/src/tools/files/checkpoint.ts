import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  WorkspaceMutationCoordinator,
  type WorkspaceFileSnapshot,
  type WorkspaceFileVersion,
  type WorkspaceMutationRecorder,
  type WorkspacePreparedMutation,
} from "./patch.js";
import { WorkspacePathGuard } from "./path-guard.js";
import { sha256 } from "./text.js";

interface CheckpointEntry {
  readonly path: string;
  readonly original: WorkspaceFileSnapshot;
  expected: WorkspaceFileVersion | null;
  chainIntact: boolean;
}

interface Checkpoint {
  readonly id: string;
  readonly entries: Map<string, CheckpointEntry>;
  turnId?: string | undefined;
  state: "active" | "ready" | "undone";
}

export interface ActiveOwnedFile {
  readonly path: string;
  readonly version: WorkspaceFileVersion | null;
  readonly chainIntact: boolean;
}

export type UndoResult =
  | {
      readonly status: "undone";
      readonly checkpointId: string;
      readonly turnId?: string | undefined;
      readonly paths: readonly string[];
    }
  | {
      readonly status: "nothing_to_undo";
      readonly message: string;
    }
  | {
      readonly status: "conflict";
      readonly checkpointId: string;
      readonly turnId?: string | undefined;
      readonly paths: readonly string[];
      readonly message: string;
    };

/** In-memory, workspace-local recovery journal for the most recent agent turn. */
export class WorkspaceCheckpointManager implements WorkspaceMutationRecorder {
  readonly #guard: WorkspacePathGuard;
  readonly #mutations: WorkspaceMutationCoordinator;
  #active: Checkpoint | undefined;
  #latest: Checkpoint | undefined;

  constructor(guard: WorkspacePathGuard, mutations: WorkspaceMutationCoordinator) {
    this.#guard = guard;
    this.#mutations = mutations;
  }

  beginTurn(): string {
    if (this.#active !== undefined) throw new Error("A checkpoint is already active");
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      entries: new Map(),
      state: "active",
    };
    this.#active = checkpoint;
    this.#latest = checkpoint;
    return checkpoint.id;
  }

  attachTurn(checkpointId: string, turnId: string): void {
    const checkpoint = this.#requireActive(checkpointId);
    if (checkpoint.turnId !== undefined && checkpoint.turnId !== turnId) {
      throw new Error("Checkpoint is already attached to another turn");
    }
    checkpoint.turnId = turnId;
  }

  finishTurn(checkpointId: string): void {
    const checkpoint = this.#requireActive(checkpointId);
    checkpoint.state = "ready";
    this.#active = undefined;
  }

  /** Files whose latest versions were produced by file tools in the running turn. */
  activeOwnedFiles(): readonly ActiveOwnedFile[] {
    const checkpoint = this.#active;
    if (checkpoint === undefined) return Object.freeze([]);
    return Object.freeze([...checkpoint.entries.values()].map((entry) => Object.freeze({
      path: entry.path,
      version: cloneVersion(entry.expected),
      chainIntact: entry.chainIntact,
    })));
  }

  prepareMutation(
    path: string,
    before: WorkspaceFileSnapshot,
  ): WorkspacePreparedMutation {
    const checkpoint = this.#active;
    if (checkpoint === undefined) return NOOP_MUTATION;
    const existing = checkpoint.entries.get(path);
    const previous = existing === undefined ? undefined : {
      expected: cloneVersion(existing.expected),
      chainIntact: existing.chainIntact,
    };
    if (existing === undefined) {
      checkpoint.entries.set(path, {
        path,
        original: cloneSnapshot(before),
        expected: cloneVersion(before.version),
        chainIntact: true,
      });
    }
    let settled = false;
    return {
      commit: (after) => {
        if (settled) return;
        settled = true;
        const entry = checkpoint.entries.get(path);
        if (entry === undefined) return;
        const expectedBefore = previous?.expected ?? before.version;
        if (!sameVersion(expectedBefore, before.version)) entry.chainIntact = false;
        entry.expected = cloneVersion(after);
      },
      abort: () => {
        if (settled) return;
        settled = true;
        const entry = checkpoint.entries.get(path);
        if (entry === undefined) return;
        if (previous === undefined) checkpoint.entries.delete(path);
        else {
          entry.expected = previous.expected;
          entry.chainIntact = previous.chainIntact;
        }
      },
    };
  }

  async undoLatest(): Promise<UndoResult> {
    if (this.#active !== undefined) {
      return { status: "nothing_to_undo", message: "Cannot undo while a turn is running." };
    }
    const checkpoint = this.#latest;
    if (checkpoint === undefined || checkpoint.state === "undone") {
      return { status: "nothing_to_undo", message: "There is no completed agent turn to undo." };
    }
    const entries = [...checkpoint.entries.values()];
    if (entries.length === 0) {
      return { status: "nothing_to_undo", message: "The latest agent turn did not change files." };
    }
    const paths = Object.freeze(entries.map((entry) => entry.path));
    const broken = entries.filter((entry) => !entry.chainIntact).map((entry) => entry.path);
    if (broken.length > 0) {
      return conflictResult(
        checkpoint,
        paths,
        `Undo refused because these files changed outside the Agent between its writes: ${broken.join(", ")}`,
      );
    }

    return await this.#mutations.runExclusiveMany(paths, async () => {
      for (const entry of entries) {
        let current: WorkspaceFileVersion | null;
        try {
          current = await readVersion(this.#guard, entry.path);
        } catch (error) {
          return conflictResult(checkpoint, paths, conflictMessage(entry.path, error));
        }
        if (!sameVersion(current, entry.expected)) {
          return conflictResult(
            checkpoint,
            paths,
            `Undo refused because ${entry.path} no longer matches the version written by the Agent.`,
          );
        }
      }

      try {
        for (const entry of [...entries].reverse()) await this.#restore(entry);
      } catch (error) {
        return conflictResult(checkpoint, paths, conflictMessage("workspace", error));
      }
      checkpoint.state = "undone";
      return {
        status: "undone" as const,
        checkpointId: checkpoint.id,
        ...(checkpoint.turnId === undefined ? {} : { turnId: checkpoint.turnId }),
        paths,
      };
    });
  }

  async #restore(entry: CheckpointEntry): Promise<void> {
    if (sameVersion(entry.original.version, entry.expected)) return;
    if (entry.original.version === null) {
      await revalidate(this.#guard, entry.path, entry.expected);
      const target = await this.#guard.resolveForWrite(entry.path);
      if (target.exists) await unlink(target.lexicalPath);
      return;
    }
    const content = entry.original.content;
    if (content === null) throw new Error(`Checkpoint content is missing for ${entry.path}`);
    await atomicRestore(
      this.#guard,
      entry.path,
      content,
      entry.original.version.mode,
      entry.expected,
    );
  }

  #requireActive(checkpointId: string): Checkpoint {
    if (this.#active?.id !== checkpointId) throw new Error("Checkpoint is not active");
    return this.#active;
  }
}

async function atomicRestore(
  guard: WorkspacePathGuard,
  path: string,
  content: Buffer,
  mode: number,
  expected: WorkspaceFileVersion | null,
): Promise<void> {
  const target = await guard.resolveForWrite(path);
  const temporary = join(dirname(target.lexicalPath), `.${basename(path)}.agent-code-undo-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", mode);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await revalidate(guard, path, expected);
    await rename(temporary, target.lexicalPath);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function revalidate(
  guard: WorkspacePathGuard,
  path: string,
  expected: WorkspaceFileVersion | null,
): Promise<void> {
  const current = await readVersion(guard, path);
  if (!sameVersion(current, expected)) {
    throw new Error(`${path} changed while undo was being prepared`);
  }
}

async function readVersion(
  guard: WorkspacePathGuard,
  path: string,
): Promise<WorkspaceFileVersion | null> {
  const target = await guard.resolveForWrite(path);
  if (!target.exists) return null;
  const metadata = await lstat(target.lexicalPath);
  if (!metadata.isFile()) throw new Error(`${path} is no longer a regular file`);
  const content = await readFile(target.lexicalPath);
  return { hash: sha256(content), mode: metadata.mode & 0o777 };
}

function sameVersion(
  left: WorkspaceFileVersion | null,
  right: WorkspaceFileVersion | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.hash === right.hash && left.mode === right.mode;
}

function cloneSnapshot(snapshot: WorkspaceFileSnapshot): WorkspaceFileSnapshot {
  return {
    version: cloneVersion(snapshot.version),
    content: snapshot.content === null ? null : Buffer.from(snapshot.content),
  };
}

function cloneVersion(version: WorkspaceFileVersion | null): WorkspaceFileVersion | null {
  return version === null ? null : { ...version };
}

function conflictResult(
  checkpoint: Checkpoint,
  paths: readonly string[],
  message: string,
): UndoResult {
  return {
    status: "conflict",
    checkpointId: checkpoint.id,
    ...(checkpoint.turnId === undefined ? {} : { turnId: checkpoint.turnId }),
    paths,
    message,
  };
}

function conflictMessage(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Undo refused for ${path}: ${detail}`;
}

const NOOP_MUTATION: WorkspacePreparedMutation = Object.freeze({
  commit: () => undefined,
  abort: () => undefined,
});
