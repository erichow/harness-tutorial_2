import { describe, expect, it } from "vitest";

import { RuntimeEventLog } from "../../src/runtime/event-log.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";

const base = {
  protocolVersion: 1 as const,
  timestamp: "2026-07-23T00:00:00.000Z",
  turnId: "turn-1",
};

describe("RuntimeEventLog", () => {
  it("records a validated event stream and derives real file changes", () => {
    const log = new RuntimeEventLog();
    const events: RuntimeEvent[] = [
      { ...base, sequence: 0, type: "turn_started" },
      {
        ...base,
        sequence: 1,
        type: "tool_call_finished",
        result: {
          type: "tool_result",
          toolCallId: "patch-1",
          status: "success",
          content: "updated",
          data: {
            operation: "update",
            path: "src/config.js",
            beforeHash: `sha256:${"a".repeat(64)}`,
            afterHash: `sha256:${"b".repeat(64)}`,
            diff: "--- a/src/config.js\n+++ b/src/config.js\n@@ -1,1 +1,1 @@\n-old\n+new",
            additions: 1,
            deletions: 1,
          },
          output: { contentBytes: 7, totalContentBytes: 7, truncated: false },
        },
      },
      { ...base, sequence: 2, type: "turn_finished", reason: "completed" },
    ];

    for (const event of events) log.append(event);

    expect(log.entries).toHaveLength(3);
    expect(log.fileChanges).toEqual([
      expect.objectContaining({
        toolCallId: "patch-1",
        operation: "update",
        path: "src/config.js",
      }),
    ]);
    expect(log.changesForTurn("turn-1")).toEqual({
      turnId: "turn-1",
      files: ["src/config.js"],
      changes: log.fileChanges,
      additions: 1,
      deletions: 1,
    });
    expect(log.toJSONLines().split("\n")).toHaveLength(3);
    expect(Object.isFrozen(log.entries[1])).toBe(true);
  });

  it("rejects gaps and events after a turn finishes", () => {
    const gap = new RuntimeEventLog();
    gap.append({ ...base, sequence: 0, type: "turn_started" });
    expect(() => gap.append({ ...base, sequence: 2, type: "turn_finished", reason: "completed" }))
      .toThrow("expected sequence 1");

    const finished = new RuntimeEventLog();
    finished.append({ ...base, sequence: 0, type: "turn_started" });
    finished.append({ ...base, sequence: 1, type: "turn_finished", reason: "completed" });
    expect(() => finished.append({ ...base, sequence: 2, type: "text_delta", delta: "late" }))
      .toThrow("already finished");
  });

  it("deduplicates the per-turn file set while retaining each line-level change", () => {
    const log = new RuntimeEventLog();
    log.append({ ...base, sequence: 0, type: "turn_started" });
    for (const [index, hashes] of [
      ["a", "b"],
      ["b", "c"],
    ].entries()) {
      log.append({
        ...base,
        sequence: index + 1,
        type: "tool_call_finished",
        result: {
          type: "tool_result",
          toolCallId: `patch-${index + 1}`,
          status: "success",
          content: "updated",
          data: {
            operation: "update",
            path: "same.txt",
            beforeHash: `sha256:${(hashes[0] ?? "a").repeat(64)}`,
            afterHash: `sha256:${(hashes[1] ?? "b").repeat(64)}`,
            diff: `diff-${index + 1}`,
            additions: index + 1,
            deletions: 1,
          },
          output: { contentBytes: 7, totalContentBytes: 7, truncated: false },
        },
      });
    }

    expect(log.changesForTurn("turn-1")).toMatchObject({
      files: ["same.txt"],
      additions: 3,
      deletions: 2,
      changes: [{ toolCallId: "patch-1" }, { toolCallId: "patch-2" }],
    });
    expect(log.changesForTurn("missing")).toEqual({
      turnId: "missing",
      files: [],
      changes: [],
      additions: 0,
      deletions: 0,
    });
  });
});
