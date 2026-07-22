import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { WorkspacePathGuard } from "./path-guard.js";
import { decodeUtf8, encodeUtf8, joinLines, sha256, splitLines } from "./text.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const PATCH_FORMAT_GUIDE = [
  "The patch string must use this exact format (no Markdown fence):",
  "*** Begin Patch",
  "*** Update File: path/to/file",
  "@@ -1,1 +1,1 @@",
  "-old line",
  "+new line",
  "*** End Patch",
  "For an update, every hunk needs an @@ -oldStart,oldCount +newStart,newCount @@ header.",
  "Every hunk body line must begin with one space for context, '-' for removal, or '+' for addition.",
  "Use '*** Add File: path' with every content line prefixed by '+' to add a file.",
  "Use '*** Delete File: path' with no hunk body to delete a file.",
].join("\n");

type ParsedPatch =
  | { readonly operation: "add"; readonly path: string; readonly lines: readonly string[] }
  | { readonly operation: "update"; readonly path: string; readonly hunks: readonly Hunk[] }
  | { readonly operation: "delete"; readonly path: string };

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly body: readonly string[];
}

export async function applyWorkspacePatch(
  guard: WorkspacePathGuard,
  patchText: string,
  baseHash: string | null,
  maxFileBytes: number,
  signal: AbortSignal,
): Promise<{ readonly content: string; readonly data: Record<string, string | null> }> {
  signal.throwIfAborted();
  let patch: ParsedPatch;
  try {
    patch = parsePatch(patchText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid patch format: ${message}\n\n${PATCH_FORMAT_GUIDE}`, {
      cause: error,
    });
  }
  const target = await guard.resolveForWrite(patch.path);

  if (patch.operation === "add") {
    if (baseHash !== null) throw new Error("Add File requires baseHash to be null");
    if (target.exists) throw new Error(`Cannot add an existing file: ${patch.path}`);
    const text = patch.lines.length === 0 ? "" : `${patch.lines.join("\n")}\n`;
    const bytes = encodeUtf8(text);
    await atomicWrite(guard, patch.path, bytes, undefined, null, signal);
    const hash = sha256(bytes);
    return {
      content: `Added ${patch.path}\nsha256: ${hash}`,
      data: { operation: "add", path: patch.path, beforeHash: null, afterHash: hash },
    };
  }

  if (baseHash === null || !HASH_PATTERN.test(baseHash)) {
    throw new Error(`${patch.operation} requires a valid sha256 baseHash`);
  }
  if (!target.exists) throw new Error(`File does not exist: ${patch.path}`);
  const before = await readRegularFile(target.lexicalPath);
  signal.throwIfAborted();
  if (before.buffer.byteLength > maxFileBytes) {
    throw new Error(`File exceeds the ${maxFileBytes}-byte patch limit`);
  }
  const actualHash = sha256(before.buffer);
  if (actualHash !== baseHash) throw conflict(baseHash, actualHash);
  const decoded = decodeUtf8(before.buffer);

  if (patch.operation === "delete") {
    await revalidate(guard, patch.path, baseHash);
    signal.throwIfAborted();
    await unlink(target.lexicalPath);
    return {
      content: `Deleted ${patch.path}\nprevious sha256: ${actualHash}`,
      data: { operation: "delete", path: patch.path, beforeHash: actualHash, afterHash: null },
    };
  }

  const original = splitLines(decoded.text);
  const changedLines = applyHunks(original.lines, patch.hunks);
  const changedText = joinLines(changedLines, original.eol, original.trailingNewline);
  const changed = encodeUtf8(changedText, decoded.hasBom);
  await atomicWrite(guard, patch.path, changed, before.mode, baseHash, signal);
  const afterHash = sha256(changed);
  return {
    content: `Updated ${patch.path}\nsha256: ${afterHash}`,
    data: { operation: "update", path: patch.path, beforeHash: actualHash, afterHash },
  };
}

function parsePatch(value: string): ParsedPatch {
  if (value.includes("\r")) throw new Error("Patch must use LF line endings");
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("Patch must start with '*** Begin Patch' and end with '*** End Patch'");
  }
  const header = lines.shift();
  const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header ?? "");
  if (match === null) throw new Error("Patch must contain exactly one Add, Update, or Delete File header");
  const operation = match[1]?.toLowerCase() as "add" | "update" | "delete";
  const path = match[2] ?? "";

  if (operation === "delete") {
    if (lines.length !== 0) throw new Error("Delete File patch must not contain hunks");
    return { operation, path };
  }
  if (operation === "add") {
    if (lines.some((line) => !line.startsWith("+"))) {
      throw new Error("Every Add File content line must start with '+'");
    }
    return { operation, path, lines: lines.map((line) => line.slice(1)) };
  }

  const hunks: Hunk[] = [];
  while (lines.length > 0) {
    const hunkHeader = lines.shift() ?? "";
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(hunkHeader);
    if (hunkMatch === null) throw new Error(`Invalid hunk header: ${hunkHeader}`);
    const body: string[] = [];
    while (lines.length > 0 && !lines[0]?.startsWith("@@ ")) body.push(lines.shift() ?? "");
    if (body.length === 0 || body.some((line) => ![" ", "+", "-"].includes(line[0] ?? ""))) {
      throw new Error("Hunk lines must start with space, '+' or '-'");
    }
    const oldCount = Number(hunkMatch[2] ?? 1);
    const newCount = Number(hunkMatch[4] ?? 1);
    const actualOld = body.filter((line) => line[0] !== "+").length;
    const actualNew = body.filter((line) => line[0] !== "-").length;
    if (actualOld !== oldCount || actualNew !== newCount) {
      throw new Error(`Hunk count mismatch: expected ${oldCount}/${newCount}, got ${actualOld}/${actualNew}`);
    }
    hunks.push({
      oldStart: Number(hunkMatch[1]), oldCount,
      newStart: Number(hunkMatch[3]), newCount,
      body,
    });
  }
  if (hunks.length === 0) throw new Error("Update File patch requires at least one hunk");
  return { operation, path, hunks };
}

function applyHunks(original: readonly string[], hunks: readonly Hunk[]): string[] {
  const result = [...original];
  let delta = 0;
  let previousOriginalEnd = 0;
  for (const hunk of hunks) {
    const originalIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (originalIndex < previousOriginalEnd) throw new Error("Patch hunks overlap or are out of order");
    const index = originalIndex + delta;
    const expected = hunk.body.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const replacement = hunk.body.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const actual = result.slice(index, index + hunk.oldCount);
    if (actual.length !== expected.length || actual.some((line, item) => line !== expected[item])) {
      throw new Error(`Patch context does not match at original line ${hunk.oldStart}`);
    }
    result.splice(index, hunk.oldCount, ...replacement);
    delta += hunk.newCount - hunk.oldCount;
    previousOriginalEnd = originalIndex + hunk.oldCount;
  }
  return result;
}

async function atomicWrite(
  guard: WorkspacePathGuard,
  path: string,
  content: Uint8Array,
  mode: number | undefined,
  expectedHash: string | null,
  signal: AbortSignal,
): Promise<void> {
  const target = await guard.resolveForWrite(path);
  const temporary = join(dirname(target.lexicalPath), `.${basename(path)}.agent-code-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", mode ?? 0o666);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(temporary, mode & 0o777);
    signal.throwIfAborted();
    await revalidate(guard, path, expectedHash);
    signal.throwIfAborted();
    await rename(temporary, target.lexicalPath);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function revalidate(
  guard: WorkspacePathGuard,
  path: string,
  expectedHash: string | null,
): Promise<void> {
  const target = await guard.resolveForWrite(path);
  if (expectedHash === null) {
    if (target.exists) throw new Error(`Cannot add an existing file: ${path}`);
    return;
  }
  if (!target.exists) throw new Error(`File changed after it was read: ${path}`);
  const current = await readRegularFile(target.lexicalPath);
  const actualHash = sha256(current.buffer);
  if (actualHash !== expectedHash) throw conflict(expectedHash, actualHash);
}

async function readRegularFile(path: string): Promise<{
  readonly buffer: Buffer;
  readonly mode: number;
}> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("Patch target must be a regular file");
  return { buffer: await readFile(path), mode: metadata.mode };
}

function conflict(expected: string, actual: string): Error {
  return new Error(`File changed after it was read (expected ${expected}, found ${actual}); read it again before applying a patch`);
}
