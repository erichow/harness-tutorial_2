import { describe, expect, it } from "vitest";

import { createUnifiedDiff } from "../../src/tools/files/diff.js";

describe("createUnifiedDiff", () => {
  it("creates update hunks from actual before and after text", () => {
    const result = createUnifiedDiff(
      "src/example.ts",
      "one\ntwo\nthree\n",
      "one\nchanged\nthree\n",
    );

    expect(result).toEqual({
      diff: [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+changed",
        " three",
      ].join("\n"),
      additions: 1,
      deletions: 1,
    });
  });

  it("uses /dev/null and reports missing final newlines for additions and deletions", () => {
    const added = createUnifiedDiff("note.txt", null, "hello");
    expect(added.diff).toContain("--- /dev/null\n+++ b/note.txt");
    expect(added.diff).toContain("+hello\n\\ No newline at end of file");
    expect(added).toMatchObject({ additions: 1, deletions: 0 });

    const deleted = createUnifiedDiff("note.txt", "hello\n", null);
    expect(deleted.diff).toContain("--- a/note.txt\n+++ /dev/null");
    expect(deleted.diff).toContain("-hello");
    expect(deleted).toMatchObject({ additions: 0, deletions: 1 });
  });

  it("detects a final newline change as a real line replacement", () => {
    const result = createUnifiedDiff("note.txt", "hello", "hello\n");
    expect(result).toMatchObject({ additions: 1, deletions: 1 });
    expect(result.diff).toContain("-hello\n\\ No newline at end of file\n+hello");
  });

  it("falls back to an exact coarse diff when a hostile edit exceeds the Myers budget", () => {
    const before = Array.from({ length: 800 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 800 }, (_, index) => `new-${index}`).join("\n");
    const result = createUnifiedDiff("large.txt", before, after);

    expect(result).toMatchObject({ additions: 800, deletions: 800 });
    expect(result.diff).toContain("-old-0");
    expect(result.diff).toContain("+new-799");
  });
});
