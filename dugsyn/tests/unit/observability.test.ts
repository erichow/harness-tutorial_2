import { describe, expect, it } from "vitest";

import { TraceRecorder } from "../../src/observability/trace.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";

const base = {
  protocolVersion: 1 as const,
  timestamp: "2026-07-23T00:00:00.000Z",
  turnId: "turn-1",
};

describe("TraceRecorder", () => {
  it("builds session, turn, provider, and tool spans with safe metrics", () => {
    let time = Date.parse("2026-07-23T00:00:00.000Z");
    let id = 0;
    const trace = new TraceRecorder({
      sessionId: "session-1",
      now: () => {
        time += 10;
        return time;
      },
      createId: () => `span-${id += 1}`,
    });
    const events: RuntimeEvent[] = [
      { ...base, sequence: 0, type: "turn_started" },
      {
        ...base,
        sequence: 1,
        type: "provider_request_started",
        provider: "mock",
        step: 1,
      },
      {
        ...base,
        sequence: 2,
        type: "usage",
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 4,
      },
      {
        ...base,
        sequence: 3,
        type: "provider_response",
        provider: "mock",
        requestId: "response-1",
        finishReason: "tool_calls",
      },
      {
        ...base,
        sequence: 4,
        type: "tool_call_started",
        call: {
          type: "tool_call",
          id: "call-1",
          name: "apply_patch",
          input: { secret: "DO-NOT-TRACE-INPUT" },
        },
      },
      {
        ...base,
        sequence: 5,
        type: "permission_decided",
        requestId: "fingerprint-1",
        toolCallId: "call-1",
        toolName: "apply_patch",
        decision: "deny",
        reason: "DO-NOT-TRACE-PERMISSION-REASON",
      },
      {
        ...base,
        sequence: 6,
        type: "tool_call_finished",
        result: {
          type: "tool_result",
          toolCallId: "call-1",
          status: "error",
          content: "DO-NOT-TRACE-TOOL-OUTPUT",
          error: {
            code: "permission_denied",
            message: "DO-NOT-TRACE-ERROR-MESSAGE",
            retryable: false,
          },
        },
      },
      {
        ...base,
        sequence: 7,
        type: "provider_request_started",
        provider: "mock",
        step: 2,
      },
      {
        ...base,
        sequence: 8,
        type: "error",
        category: "provider",
        message: "DO-NOT-TRACE-PROVIDER-ERROR",
        retryable: true,
      },
      { ...base, sequence: 9, type: "turn_finished", reason: "error" },
    ];

    for (const event of events) trace.record(event);
    trace.finish();
    const snapshot = trace.snapshot();
    const session = snapshot.spans.find((span) => span.kind === "session");
    const turn = snapshot.spans.find((span) => span.kind === "turn");
    const providers = snapshot.spans.filter((span) => span.kind === "provider_request");
    const tool = snapshot.spans.find((span) => span.kind === "tool_call");

    expect(session).toMatchObject({ status: "ok" });
    expect(turn).toMatchObject({ parentSpanId: session?.spanId, status: "error" });
    expect(providers).toHaveLength(2);
    expect(providers[0]).toMatchObject({
      parentSpanId: turn?.spanId,
      status: "ok",
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
    });
    expect(providers[1]).toMatchObject({
      parentSpanId: turn?.spanId,
      status: "error",
      attributes: { errorCategory: "provider", retryable: true },
    });
    expect(tool).toMatchObject({
      parentSpanId: turn?.spanId,
      name: "apply_patch",
      status: "error",
      attributes: { errorCode: "permission_denied" },
      permissions: [{ decision: "deny" }],
    });
    expect(Date.parse(providers[0]?.endedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(tool?.startedAt ?? ""),
    );
    expect(snapshot.totals).toEqual({
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      errors: 2,
      permissionDecisions: 1,
    });
    expect(snapshot.spans.every((span) =>
      span.status === "running" || (span.durationMs ?? -1) >= 0
    )).toBe(true);

    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "DO-NOT-TRACE-INPUT",
      "DO-NOT-TRACE-PERMISSION-REASON",
      "DO-NOT-TRACE-TOOL-OUTPUT",
      "DO-NOT-TRACE-ERROR-MESSAGE",
      "DO-NOT-TRACE-PROVIDER-ERROR",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("closes interrupted child spans when the session finishes", () => {
    let time = 0;
    const trace = new TraceRecorder({
      now: () => time += 5,
      createId: (() => {
        let id = 0;
        return () => `id-${id += 1}`;
      })(),
    });
    trace.record({ ...base, sequence: 0, type: "turn_started" });
    trace.record({
      ...base,
      sequence: 1,
      type: "provider_request_started",
      provider: "mock",
      step: 1,
    });

    trace.finish();

    expect(trace.snapshot().spans.map((span) => [span.kind, span.status])).toEqual([
      ["session", "ok"],
      ["turn", "error"],
      ["provider_request", "error"],
    ]);
  });
});
