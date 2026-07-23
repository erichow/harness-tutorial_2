import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { JsonValue } from "../protocol/json.js";
import type { Transcript } from "../messages/transcript.js";

export const INSTRUCTION_FILE_NAME = "AGENTS.md";
export const DEFAULT_MAX_INSTRUCTION_FILE_BYTES = 32 * 1024;
export const DEFAULT_MAX_TOTAL_INSTRUCTION_BYTES = 128 * 1024;

export interface InstructionDocument {
  readonly level: "user" | "project" | "nested";
  readonly path: string;
  readonly scope: "global" | string;
  readonly content: string;
}

export interface InstructionLoaderOptions {
  readonly workspaceRoot: string;
  readonly userInstructionPath?: string | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
}

/** Loads only the root rules and ancestors of paths that are active in the transcript. */
export class InstructionLoader {
  readonly workspaceRoot: string;
  readonly userInstructionPath: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;

  private constructor(options: {
    workspaceRoot: string;
    userInstructionPath: string;
    maxFileBytes: number;
    maxTotalBytes: number;
  }) {
    this.workspaceRoot = options.workspaceRoot;
    this.userInstructionPath = options.userInstructionPath;
    this.#maxFileBytes = positiveInteger(options.maxFileBytes, "maxFileBytes");
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes, "maxTotalBytes");
  }

  static async create(options: InstructionLoaderOptions): Promise<InstructionLoader> {
    const workspaceRoot = await realpath(options.workspaceRoot);
    const metadata = await stat(workspaceRoot);
    if (!metadata.isDirectory()) throw new TypeError(`Not a directory: ${options.workspaceRoot}`);
    return new InstructionLoader({
      workspaceRoot,
      userInstructionPath: resolve(
        options.userInstructionPath ?? join(homedir(), ".agent-code", INSTRUCTION_FILE_NAME),
      ),
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_INSTRUCTION_FILE_BYTES,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_INSTRUCTION_BYTES,
    });
  }

  async load(activePaths: readonly string[] = []): Promise<readonly InstructionDocument[]> {
    const candidates = new Map<string, Omit<InstructionDocument, "content">>();
    candidates.set(this.userInstructionPath, {
      level: "user",
      path: this.userInstructionPath,
      scope: "global",
    });

    const rootInstructions = join(this.workspaceRoot, INSTRUCTION_FILE_NAME);
    candidates.set(rootInstructions, {
      level: "project",
      path: rootInstructions,
      scope: ".",
    });

    for (const activePath of activePaths) {
      const normalized = normalizeWorkspacePath(this.workspaceRoot, activePath);
      if (normalized === undefined) continue;
      const directories = await ancestorDirectories(this.workspaceRoot, normalized);
      for (const directory of directories) {
        if (directory === this.workspaceRoot) continue;
        const path = join(directory, INSTRUCTION_FILE_NAME);
        candidates.set(path, {
          level: "nested",
          path,
          scope: toPosix(relative(this.workspaceRoot, directory)) || ".",
        });
      }
    }

    const documents: InstructionDocument[] = [];
    let totalBytes = 0;
    for (const candidate of candidates.values()) {
      const content = await readInstruction(candidate.path, this.#maxFileBytes, this.workspaceRoot,
        candidate.level !== "user");
      if (content === undefined) continue;
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > this.#maxTotalBytes) {
        throw new Error(`Instruction files exceed the ${this.#maxTotalBytes}-byte combined limit`);
      }
      documents.push({ ...candidate, content });
    }
    return documents;
  }
}

/** Extracts paths from typed tool input/result fields and explicit path-like user text. */
export function collectActivePaths(transcript: Transcript): readonly string[] {
  const paths = new Set<string>();
  for (const message of transcript.messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") {
        collectJsonPaths(block.input, paths);
        const patch = block.input.patch;
        if (typeof patch === "string") collectPatchPaths(patch, paths);
      } else if (block.type === "tool_result" && block.data !== undefined) {
        collectJsonPaths(block.data, paths);
      } else if (message.role === "user" && block.type === "text") {
        collectTextPaths(block.text, paths);
      }
    }
  }
  return [...paths];
}

function collectJsonPaths(value: JsonValue, paths: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (key === "path" || key === "file" || key === "cwd" || key === "workspace") paths.add(value);
    return;
  }
  if (Array.isArray(value)) {
    if (key === "paths" || key === "files") {
      for (const item of value) if (typeof item === "string") paths.add(item);
    } else {
      for (const item of value) collectJsonPaths(item, paths, key);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) collectJsonPaths(child, paths, childKey);
}

function collectPatchPaths(patch: string, paths: Set<string>): void {
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    const path = match[1]?.trim();
    if (path) paths.add(path);
  }
}

function collectTextPaths(text: string, paths: Set<string>): void {
  const pattern = /(?:^|[\s"'`(])((?:\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/gmu;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]?.replace(/[),.:;]+$/u, "");
    if (path) paths.add(path);
  }
}

async function ancestorDirectories(root: string, path: string): Promise<readonly string[]> {
  let directory = path;
  try {
    if (!(await stat(path)).isDirectory()) directory = dirname(path);
  } catch {
    directory = dirname(path);
  }
  const directories: string[] = [];
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    directories.unshift(directory);
    if (directory === root) break;
    directory = dirname(directory);
  }
  return directories;
}

function normalizeWorkspacePath(root: string, value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  const target = resolve(root, value);
  const scoped = relative(root, target);
  if (scoped === "" || (!scoped.startsWith(`..${sep}`) && scoped !== ".." && !isAbsolute(scoped))) {
    return target;
  }
  return undefined;
}

async function readInstruction(
  path: string,
  maxBytes: number,
  workspaceRoot: string,
  enforceWorkspace: boolean,
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (enforceWorkspace && normalizeWorkspacePath(workspaceRoot, canonical) === undefined) {
    throw new Error(`Project instruction file resolves outside the workspace: ${path}`);
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error(`Instruction path is not a regular file: ${path}`);
  if (metadata.size > maxBytes) throw new Error(`Instruction file exceeds the ${maxBytes}-byte limit: ${path}`);
  const buffer = await readFile(canonical);
  if (buffer.byteLength > maxBytes) throw new Error(`Instruction file exceeds the ${maxBytes}-byte limit: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
  } catch (error) {
    throw new Error(`Instruction file is not valid UTF-8: ${path}`, { cause: error });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
