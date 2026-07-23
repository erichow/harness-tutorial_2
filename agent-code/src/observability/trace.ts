import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "../runtime/events.js";

export const TRACE_PROTOCOL_VERSION = 1 as const;

export type TraceSpanKind = "session" | "turn" | "provider_request" | "tool_call";
export type TraceSpanStatus = "running" | "ok" | "error" | "cancelled";

export interface TraceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface TracePermissionDecision {
  readonly decision: "allow" | "deny";
  readonly scope?: "once" | "session" | undefined;
}

export interface TraceSpan {
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly kind: TraceSpanKind;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status: TraceSpanStatus;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly usage: TraceUsage;
  readonly permissions: readonly TracePermissionDecision[];
}

export interface TraceSnapshot {
  readonly protocolVersion: typeof TRACE_PROTOCOL_VERSION;
  readonly traceId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly spans: readonly TraceSpan[];
  readonly totals: {
    readonly usage: TraceUsage;
    readonly errors: number;
    readonly permissionDecisions: number;
  };
}

export interface TraceRecorderOptions {
  readonly sessionId?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly createId?: (() => string) | undefined;
}

interface MutableSpan {
  spanId: string;
  parentSpanId?: string | undefined;
  kind: TraceSpanKind;
  name: string;
  startedAtMs: number;
  endedAtMs?: number | undefined;
  status: TraceSpanStatus;
  attributes: Record<string, string | number | boolean>;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  permissions: TracePermissionDecision[];
}

/**
 * Converts the public runtime stream into low-cardinality spans. It deliberately
 * never records prompts, tool inputs, tool output, hook payloads, or error text.
 */
export class TraceRecorder {
  readonly traceId: string;
  readonly sessionId: string;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #sessionSpan: MutableSpan;
  readonly #spans: MutableSpan[] = [];
  readonly #turns = new Map<string, MutableSpan>();
  readonly #providers = new Map<string, MutableSpan>();
  readonly #tools = new Map<string, MutableSpan>();
  #errors = 0;

  constructor(options: TraceRecorderOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.traceId = this.#createId();
    this.sessionId = options.sessionId ?? this.#createId();
    this.#sessionSpan = this.#start("session", "agent-code session");
  }

  record(event: RuntimeEvent): void {
    const observedAt = this.#now();
    switch (event.type) {
      case "turn_started": {
        const span = this.#start("turn", "agent turn", this.#sessionSpan.spanId, observedAt);
        span.attributes.turnId = event.turnId;
        this.#turns.set(event.turnId, span);
        return;
      }
      case "provider_request_started": {
        this.#closeProvider(event.turnId, "error", observedAt);
        const parent = this.#turns.get(event.turnId);
        const span = this.#start(
          "provider_request",
          event.provider,
          parent?.spanId ?? this.#sessionSpan.spanId,
          observedAt,
        );
        span.attributes.step = event.step;
        this.#providers.set(event.turnId, span);
        return;
      }
      case "usage": {
        const span = this.#providers.get(event.turnId);
        if (span !== undefined) addUsage(span.usage, event);
        return;
      }
      case "provider_response": {
        const span = this.#providers.get(event.turnId);
        if (span !== undefined) {
          span.attributes.finishReason = event.finishReason;
          span.attributes.requestId = event.requestId;
        }
        this.#closeProvider(event.turnId, "ok", observedAt);
        return;
      }
      case "tool_call_started": {
        const parent = this.#turns.get(event.turnId);
        const span = this.#start(
          "tool_call",
          event.call.name,
          parent?.spanId ?? this.#sessionSpan.spanId,
          observedAt,
        );
        span.attributes.toolCallId = event.call.id;
        this.#tools.set(event.call.id, span);
        return;
      }
      case "permission_requested":
        return;
      case "permission_decided": {
        const span = this.#tools.get(event.toolCallId);
        span?.permissions.push(Object.freeze({
          decision: event.decision,
          ...(event.scope === undefined ? {} : { scope: event.scope }),
        }));
        return;
      }
      case "tool_call_finished": {
        const span = this.#tools.get(event.result.toolCallId);
        if (span === undefined) return;
        span.attributes.result = event.result.status;
        if (event.result.error !== undefined) {
          span.attributes.errorCode = event.result.error.code;
        }
        if (event.result.status === "error") this.#errors += 1;
        this.#finish(span, event.result.status === "success" ? "ok" : "error", observedAt);
        this.#tools.delete(event.result.toolCallId);
        return;
      }
      case "error": {
        this.#errors += 1;
        const provider = this.#providers.get(event.turnId);
        if (provider !== undefined) {
          provider.attributes.errorCategory = event.category;
          provider.attributes.retryable = event.retryable;
          this.#closeProvider(
            event.turnId,
            event.category === "cancelled" ? "cancelled" : "error",
            observedAt,
          );
        }
        return;
      }
      case "turn_finished": {
        this.#closeProvider(event.turnId, event.reason === "cancelled" ? "cancelled" : "error", observedAt);
        for (const [toolCallId, span] of this.#tools) {
          if (span.parentSpanId === this.#turns.get(event.turnId)?.spanId) {
            this.#finish(span, event.reason === "cancelled" ? "cancelled" : "error", observedAt);
            this.#tools.delete(toolCallId);
          }
        }
        const span = this.#turns.get(event.turnId);
        if (span !== undefined) {
          span.attributes.reason = event.reason;
          if (event.tests !== undefined) {
            span.attributes.testStatus = event.tests.status;
            span.attributes.testRuns = event.tests.runs;
          }
          this.#finish(
            span,
            event.reason === "completed"
              ? "ok"
              : event.reason === "cancelled"
                ? "cancelled"
                : "error",
            observedAt,
          );
          this.#turns.delete(event.turnId);
        }
        return;
      }
      case "text_delta":
      case "reasoning_summary_delta":
        return;
    }
  }

  finish(): void {
    if (this.#sessionSpan.endedAtMs !== undefined) return;
    const endedAt = this.#now();
    for (const turnId of [...this.#providers.keys()]) this.#closeProvider(turnId, "error", endedAt);
    for (const span of this.#tools.values()) this.#finish(span, "error", endedAt);
    this.#tools.clear();
    for (const span of this.#turns.values()) this.#finish(span, "error", endedAt);
    this.#turns.clear();
    this.#finish(this.#sessionSpan, "ok", endedAt);
  }

  snapshot(): TraceSnapshot {
    const generatedAt = this.#now();
    const spans = this.#spans.map((span) => freezeSpan(span));
    const totals = spans
      .filter((span) => span.kind === "provider_request")
      .reduce(
        (usage, span) => ({
          inputTokens: usage.inputTokens + span.usage.inputTokens,
          outputTokens: usage.outputTokens + span.usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens + span.usage.cachedInputTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      );
    return Object.freeze({
      protocolVersion: TRACE_PROTOCOL_VERSION,
      traceId: this.traceId,
      sessionId: this.sessionId,
      generatedAt: new Date(generatedAt).toISOString(),
      spans: Object.freeze(spans),
      totals: Object.freeze({
        usage: Object.freeze(totals),
        errors: this.#errors,
        permissionDecisions: spans.reduce(
          (count, span) => count + span.permissions.length,
          0,
        ),
      }),
    });
  }

  #start(
    kind: TraceSpanKind,
    name: string,
    parentSpanId?: string,
    startedAtMs = this.#now(),
  ): MutableSpan {
    const span: MutableSpan = {
      spanId: this.#createId(),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      kind,
      name,
      startedAtMs,
      status: "running",
      attributes: {},
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      permissions: [],
    };
    this.#spans.push(span);
    return span;
  }

  #finish(span: MutableSpan, status: Exclude<TraceSpanStatus, "running">, endedAt: number): void {
    if (span.endedAtMs !== undefined) return;
    span.endedAtMs = Math.max(span.startedAtMs, endedAt);
    span.status = status;
  }

  #closeProvider(
    turnId: string,
    status: Exclude<TraceSpanStatus, "running">,
    endedAt: number,
  ): void {
    const span = this.#providers.get(turnId);
    if (span === undefined) return;
    this.#finish(span, status, endedAt);
    this.#providers.delete(turnId);
  }
}

function addUsage(
  target: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  event: Extract<RuntimeEvent, { type: "usage" }>,
): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.cachedInputTokens += event.cachedInputTokens ?? 0;
}

function freezeSpan(span: MutableSpan): TraceSpan {
  const endedAt = span.endedAtMs;
  return Object.freeze({
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    kind: span.kind,
    name: span.name,
    startedAt: new Date(span.startedAtMs).toISOString(),
    ...(endedAt === undefined
      ? {}
      : {
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - span.startedAtMs,
        }),
    status: span.status,
    attributes: Object.freeze({ ...span.attributes }),
    usage: Object.freeze({ ...span.usage }),
    permissions: Object.freeze(span.permissions.map((item) => Object.freeze({ ...item }))),
  });
}
