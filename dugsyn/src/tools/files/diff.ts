import { splitLines } from "./text.js";

export interface UnifiedDiffResult {
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
}

interface DiffLine {
  readonly text: string;
  readonly terminated: boolean;
}

interface DiffOperation {
  readonly type: "equal" | "insert" | "delete";
  readonly line: DiffLine;
}

const CONTEXT_LINES = 3;
const MAX_MYERS_STEPS = 250_000;

/** Create a deterministic unified diff from the bytes actually read and written. */
export function createUnifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
): UnifiedDiffResult {
  const oldLines = before === null ? [] : toDiffLines(before);
  const newLines = after === null ? [] : toDiffLines(after);
  const operations = diffLines(oldLines, newLines);
  const additions = operations.filter((operation) => operation.type === "insert").length;
  const deletions = operations.filter((operation) => operation.type === "delete").length;
  const oldLabel = before === null ? "/dev/null" : `a/${path}`;
  const newLabel = after === null ? "/dev/null" : `b/${path}`;
  const output = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  for (const [start, end] of hunkRanges(operations)) {
    const slice = operations.slice(start, end);
    const oldBefore = consumedLines(operations.slice(0, start), "old");
    const newBefore = consumedLines(operations.slice(0, start), "new");
    const oldCount = consumedLines(slice, "old");
    const newCount = consumedLines(slice, "new");
    output.push(
      `@@ -${rangeStart(oldBefore, oldCount)},${oldCount} +${rangeStart(newBefore, newCount)},${newCount} @@`,
    );
    for (const operation of slice) {
      const prefix = operation.type === "equal" ? " " : operation.type === "delete" ? "-" : "+";
      output.push(`${prefix}${operation.line.text}`);
      if (!operation.line.terminated) output.push("\\ No newline at end of file");
    }
  }

  return Object.freeze({ diff: output.join("\n"), additions, deletions });
}

function toDiffLines(text: string): DiffLine[] {
  const split = splitLines(text);
  return split.lines.map((line, index) => ({
    text: line,
    terminated: index < split.lines.length - 1 || split.trailingNewline,
  }));
}

/** Myers' shortest-edit-script algorithm with a bounded-work coarse fallback. */
function diffLines(oldLines: readonly DiffLine[], newLines: readonly DiffLine[]): DiffOperation[] {
  const maximum = oldLines.length + newLines.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: ReadonlyMap<number, number>[] = [];
  let steps = 0;

  for (let distance = 0; distance <= maximum; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      steps += 1;
      if (steps > MAX_MYERS_STEPS) return coarseDiff(oldLines, newLines);
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : right + 1;
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        sameLine(oldLines[oldIndex], newLines[newIndex])
      ) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        return backtrack(trace, oldLines, newLines);
      }
    }
  }
  throw new Error("Unable to calculate line diff");
}

/** Exact but non-minimal fallback that keeps adversarial diffs within a fixed CPU budget. */
function coarseDiff(
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
): DiffOperation[] {
  return [
    ...oldLines.map((line): DiffOperation => ({ type: "delete", line })),
    ...newLines.map((line): DiffOperation => ({ type: "insert", line })),
  ];
}

function backtrack(
  trace: readonly ReadonlyMap<number, number>[],
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
): DiffOperation[] {
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  const reversed: DiffOperation[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    if (frontier === undefined) throw new Error("Invalid diff trace");
    const diagonal = oldIndex - newIndex;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousOld = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousNew = previousOld - previousDiagonal;

    while (oldIndex > previousOld && newIndex > previousNew) {
      const line = oldLines[oldIndex - 1];
      if (line === undefined) throw new Error("Invalid old line while calculating diff");
      reversed.push({ type: "equal", line });
      oldIndex -= 1;
      newIndex -= 1;
    }
    if (distance === 0) break;
    if (oldIndex === previousOld) {
      const line = newLines[newIndex - 1];
      if (line === undefined) throw new Error("Invalid inserted line while calculating diff");
      reversed.push({ type: "insert", line });
      newIndex -= 1;
    } else {
      const line = oldLines[oldIndex - 1];
      if (line === undefined) throw new Error("Invalid deleted line while calculating diff");
      reversed.push({ type: "delete", line });
      oldIndex -= 1;
    }
  }

  return reversed.reverse();
}

function sameLine(left: DiffLine | undefined, right: DiffLine | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.text === right.text && left.terminated === right.terminated;
}

function hunkRanges(operations: readonly DiffOperation[]): Array<readonly [number, number]> {
  const changes = operations
    .map((operation, index) => operation.type === "equal" ? -1 : index)
    .filter((index) => index >= 0);
  if (changes.length === 0) return [];

  const ranges: Array<readonly [number, number]> = [];
  let start = Math.max(0, (changes[0] ?? 0) - CONTEXT_LINES);
  let end = Math.min(operations.length, (changes[0] ?? 0) + CONTEXT_LINES + 1);
  for (const change of changes.slice(1)) {
    if (change <= end + CONTEXT_LINES) {
      end = Math.min(operations.length, change + CONTEXT_LINES + 1);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, change - CONTEXT_LINES);
      end = Math.min(operations.length, change + CONTEXT_LINES + 1);
    }
  }
  ranges.push([start, end]);
  return ranges;
}

function consumedLines(
  operations: readonly DiffOperation[],
  side: "old" | "new",
): number {
  return operations.filter((operation) =>
    side === "old" ? operation.type !== "insert" : operation.type !== "delete"
  ).length;
}

function rangeStart(consumedBefore: number, count: number): number {
  return count === 0 ? consumedBefore : consumedBefore + 1;
}
