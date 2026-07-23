import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject } from "../../protocol/json.js";
import type { Tool } from "../tool.js";
import { decodeCursor, encodeCursor, paginateLines } from "./cursor.js";
import { WorkspacePathGuard } from "./path-guard.js";
import {
  applyWorkspacePatch,
  PATCH_FORMAT_GUIDE,
  WorkspaceMutationCoordinator,
} from "./patch.js";
import { WorkspaceFilePolicy, type WorkspaceFilePolicyOptions } from "./policy.js";
import { clipLine, decodeUtf8, sha256, splitLines } from "./text.js";

const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_SEARCH_FILES = 10_000;
const DEFAULT_MAX_LIST_ENTRIES = 20_000;
const DEFAULT_MAX_SEARCH_MATCHES = 20_000;

export interface WorkspaceFileToolsOptions extends WorkspaceFilePolicyOptions {
  readonly workspaceRoot: string;
  readonly maxFileBytes?: number | undefined;
  readonly maxSearchFiles?: number | undefined;
}

export async function createWorkspaceFileTools(
  options: WorkspaceFileToolsOptions,
): Promise<readonly Tool[]> {
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
  const maxSearchFiles = positiveInteger(
    options.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES,
    "maxSearchFiles",
  );
  const policy = new WorkspaceFilePolicy({
    ...(options.dependencyDirectories === undefined
      ? {}
      : { dependencyDirectories: options.dependencyDirectories }),
  });
  const guard = await WorkspacePathGuard.create(options.workspaceRoot, policy);
  const mutations = new WorkspaceMutationCoordinator();

  return Object.freeze([
    createListFilesTool(guard, policy),
    createSearchTextTool(guard, policy, maxFileBytes, maxSearchFiles),
    createReadFileTool(guard, maxFileBytes),
    createApplyPatchTool(guard, mutations, maxFileBytes),
  ]);
}

function createListFilesTool(guard: WorkspacePathGuard, policy: WorkspaceFilePolicy): Tool {
  return {
    definition: {
      name: "list_files",
      description: "List workspace files recursively without reading file contents. Paths use forward slashes.",
      inputSchema: objectSchema({
        path: { type: "string", maxLength: 4_096, default: "." },
        maxDepth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      }),
    },
    sideEffects: ["read_workspace"],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const requestedPath = stringValue(input, "path", ".");
      const maxDepth = numberValue(input, "maxDepth", 4);
      const resolved = await guard.resolveExisting(requestedPath, true);
      const metadata = await stat(resolved.realPath);
      if (!metadata.isDirectory()) throw new Error("list_files path must be a directory");
      const lines: string[] = [];
      const discoveryComplete = await walkDirectory(
        resolved.realPath,
        resolved.relativePath,
        maxDepth,
        policy,
        context.signal,
        async (entry) => {
          lines.push(`${entry.path}${entry.kind === "directory" ? "/" : entry.kind === "symlink" ? " [symlink]" : ""}`);
          return lines.length < DEFAULT_MAX_LIST_ENTRIES;
        },
      );
      const scope = `list:${resolved.relativePath}:${maxDepth}`;
      const offset = decodeCursor(optionalString(input, "cursor"), scope);
      const page = paginateLines(
        lines,
        offset,
        context.maxOutputBytes,
        `workspace: ${resolved.relativePath || "."}\nentries: ${lines.length}${discoveryComplete ? "" : "+ (limit reached)"}`,
      );
      return {
        content: page.content,
        data: {
          path: resolved.relativePath || ".",
          totalEntries: lines.length,
          entryLimitReached: !discoveryComplete,
        },
        ...(page.nextOffset === undefined ? {} : { nextCursor: encodeCursor(scope, page.nextOffset) }),
      };
    },
  };
}

function createReadFileTool(guard: WorkspacePathGuard, maxFileBytes: number): Tool {
  return {
    definition: {
      name: "read_file",
      description: "Read a UTF-8 workspace file with line numbers and return its SHA-256 for later apply_patch calls.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1, maxLength: 4_096 },
        maxLines: { type: "integer", minimum: 1, maximum: 400, default: 200 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      }, ["path"]),
    },
    sideEffects: ["read_workspace"],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const resolved = await guard.resolveExisting(stringValue(input, "path"));
      const metadata = await stat(resolved.realPath);
      if (!metadata.isFile()) throw new Error("read_file path must be a regular file");
      if (metadata.size > maxFileBytes) {
        throw new Error(`File exceeds the ${maxFileBytes}-byte read limit`);
      }
      const buffer = await readFile(resolved.realPath);
      context.signal.throwIfAborted();
      if (buffer.byteLength > maxFileBytes) {
        throw new Error(`File exceeds the ${maxFileBytes}-byte read limit`);
      }
      const decoded = decodeUtf8(buffer);
      const hash = sha256(buffer);
      const lines = splitLines(decoded.text).lines;
      const maxLines = numberValue(input, "maxLines", 200);
      const scope = `read:${resolved.relativePath}:${hash}:${maxLines}`;
      const offset = decodeCursor(optionalString(input, "cursor"), scope);
      if (offset > lines.length) throw new Error("Invalid or stale cursor");
      const slice = lines.slice(offset, offset + maxLines).map(
        (line, index) => `${String(offset + index + 1).padStart(6)}\t${clipLine(line)}`,
      );
      const header = `path: ${resolved.relativePath}\nsha256: ${hash}\nlines: ${lines.length}`;
      const page = paginateLines(slice, 0, context.maxOutputBytes, header);
      const consumed = page.nextOffset ?? slice.length;
      const nextOffset = offset + consumed;
      return {
        content: page.content,
        data: {
          path: resolved.relativePath,
          sha256: hash,
          version: { algorithm: "sha256", value: hash },
          totalLines: lines.length,
          startLine: lines.length === 0 ? 0 : offset + 1,
          endLine: offset + consumed,
          hasBom: decoded.hasBom,
        },
        ...(nextOffset < lines.length ? { nextCursor: encodeCursor(scope, nextOffset) } : {}),
      };
    },
  };
}

function createSearchTextTool(
  guard: WorkspacePathGuard,
  policy: WorkspaceFilePolicy,
  maxFileBytes: number,
  maxSearchFiles: number,
): Tool {
  return {
    definition: {
      name: "search_text",
      description: "Search for a literal string in UTF-8 workspace files. Skips protected, binary, and oversized files.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1, maxLength: 256 },
        path: { type: "string", maxLength: 4_096, default: "." },
        caseSensitive: { type: "boolean", default: true },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      }, ["query"]),
    },
    sideEffects: ["read_workspace"],
    async handler(input, context) {
      context.signal.throwIfAborted();
      const query = stringValue(input, "query");
      if (query.includes("\n") || query.includes("\r")) throw new Error("search_text query must be one line");
      const requestedPath = stringValue(input, "path", ".");
      const caseSensitive = booleanValue(input, "caseSensitive", true);
      const resolved = await guard.resolveExisting(requestedPath, true);
      const metadata = await stat(resolved.realPath);
      const candidates: Array<{ path: string; realPath: string }> = [];
      let fileDiscoveryComplete = true;
      if (metadata.isFile()) {
        candidates.push({ path: resolved.relativePath, realPath: resolved.realPath });
      } else if (metadata.isDirectory()) {
        fileDiscoveryComplete = await walkDirectory(
          resolved.realPath,
          resolved.relativePath,
          64,
          policy,
          context.signal,
          async (entry) => {
            if (entry.kind === "file" && candidates.length < maxSearchFiles) {
              candidates.push({ path: entry.path, realPath: entry.realPath });
            }
            return candidates.length < maxSearchFiles;
          },
        );
      } else {
        throw new Error("search_text path must be a regular file or directory");
      }

      const needle = caseSensitive ? query : query.toLocaleLowerCase();
      const matches: string[] = [];
      let skipped = 0;
      let filesScanned = 0;
      let matchLimitReached = false;
      searchFiles:
      for (const candidate of candidates) {
        context.signal.throwIfAborted();
        filesScanned += 1;
        const fileMetadata = await stat(candidate.realPath);
        if (fileMetadata.size > maxFileBytes) { skipped += 1; continue; }
        try {
          const buffer = await readFile(candidate.realPath);
          if (buffer.byteLength > maxFileBytes) { skipped += 1; continue; }
          const decoded = decodeUtf8(buffer);
          for (const [lineIndex, line] of splitLines(decoded.text).lines.entries()) {
            const haystack = caseSensitive ? line : line.toLocaleLowerCase();
            let from = 0;
            while (from <= haystack.length) {
              const column = haystack.indexOf(needle, from);
              if (column < 0) break;
              matches.push(`${candidate.path}:${lineIndex + 1}:${column + 1}: ${clipLine(line, 500)}`);
              if (matches.length >= DEFAULT_MAX_SEARCH_MATCHES) {
                matchLimitReached = true;
                break searchFiles;
              }
              from = column + Math.max(1, needle.length);
            }
          }
        } catch {
          context.signal.throwIfAborted();
          skipped += 1;
        }
      }
      const resultHash = sha256(Buffer.from(matches.join("\n"), "utf8"));
      const scope = `search:${resolved.relativePath}:${query}:${caseSensitive}:${resultHash}`;
      const offset = decodeCursor(optionalString(input, "cursor"), scope);
      const page = paginateLines(
        matches,
        offset,
        context.maxOutputBytes,
        `query: ${JSON.stringify(query)}\nmatches: ${matches.length}${matchLimitReached ? "+ (limit reached)" : ""}\nfiles scanned: ${filesScanned}${fileDiscoveryComplete ? "" : "+ (selection limit reached)"}\nfiles skipped: ${skipped}`,
      );
      return {
        content: page.content,
        data: {
          matches: matches.length,
          matchLimitReached,
          filesScanned,
          fileLimitReached: !fileDiscoveryComplete,
          filesSkipped: skipped,
        },
        ...(page.nextOffset === undefined ? {} : { nextCursor: encodeCursor(scope, page.nextOffset) }),
      };
    },
  };
}

function createApplyPatchTool(
  guard: WorkspacePathGuard,
  mutations: WorkspaceMutationCoordinator,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Tool {
  return {
    definition: {
      name: "apply_patch",
      description: [
        "Add, update, or delete exactly one workspace file with a checked patch.",
        "For update/delete, copy baseHash exactly from read_file's sha256 result; use null only for Add File.",
        PATCH_FORMAT_GUIDE,
      ].join("\n"),
      inputSchema: objectSchema({
        patch: {
          type: "string",
          minLength: 1,
          maxLength: 1_048_576,
          description: PATCH_FORMAT_GUIDE,
        },
        baseHash: {
          description: "For Update/Delete, the exact sha256 returned by read_file. For Add File, null.",
          oneOf: [
            { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
            { type: "null" },
          ],
        },
      }, ["patch", "baseHash"]),
    },
    sideEffects: ["write_workspace"],
    async handler(input, context) {
      return await applyWorkspacePatch(
        guard,
        stringValue(input, "patch"),
        input.baseHash === null ? null : stringValue(input, "baseHash"),
        maxFileBytes,
        context.signal,
        mutations,
      );
    },
  };
}

interface WalkEntry {
  readonly path: string;
  readonly realPath: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

async function walkDirectory(
  directory: string,
  displayDirectory: string,
  maxDepth: number,
  policy: WorkspaceFilePolicy,
  signal: AbortSignal,
  visit: (entry: WalkEntry) => Promise<boolean | void>,
  depth = 1,
): Promise<boolean> {
  signal.throwIfAborted();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    signal.throwIfAborted();
    const displayPath = displayDirectory ? `${displayDirectory}/${entry.name}` : entry.name;
    if (policy.shouldSkip(displayPath)) continue;
    const realPath = join(directory, entry.name);
    const kind: WalkEntry["kind"] = entry.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
    const shouldContinue = await visit({ path: displayPath, realPath, kind });
    if (shouldContinue === false) return false;
    if (kind === "directory" && depth < maxDepth) {
      const completed = await walkDirectory(realPath, displayPath, maxDepth, policy, signal, visit, depth + 1);
      if (!completed) return false;
    }
  }
  return true;
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
