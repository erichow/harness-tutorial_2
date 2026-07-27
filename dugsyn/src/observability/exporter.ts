import type { RuntimeEvent } from "../runtime/events.js";

export const AUDIT_PROTOCOL_VERSION = 1 as const;

export interface AuditRecord {
  readonly protocolVersion: typeof AUDIT_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly eventType: RuntimeEvent["type"];
  readonly turnId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface AuditExporter {
  export(record: AuditRecord, signal: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}

export interface RemoteAuditExporterOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly failureMode?: "open" | "closed" | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly diagnostic?: ((message: string) => void) | undefined;
}

/**
 * Sends one redacted, metadata-only event per request. Authentication headers
 * are transport configuration and are never copied into records or diagnostics.
 */
export class RemoteAuditExporter implements AuditExporter {
  readonly #endpoint: string;
  readonly #sessionId: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #failureMode: "open" | "closed";
  readonly #fetch: typeof fetch;
  readonly #diagnostic: (message: string) => void;

  constructor(options: RemoteAuditExporterOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:") {
      throw new TypeError("Remote audit endpoint must use https");
    }
    this.#endpoint = endpoint.href;
    this.#sessionId = options.sessionId;
    this.#headers = Object.freeze({ ...options.headers });
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#failureMode = options.failureMode ?? "open";
    this.#fetch = options.fetch ?? fetch;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
  }

  async export(record: AuditRecord, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.#headers,
        },
        body: JSON.stringify(record),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      const message = `Remote audit export failed: ${describeError(error)}`;
      if (this.#failureMode === "closed") throw new Error(message, { cause: error });
      this.#diagnostic(message);
    }
  }

  record(event: RuntimeEvent): AuditRecord {
    return createAuditRecord(this.#sessionId, event);
  }
}

export function createAuditRecord(sessionId: string, event: RuntimeEvent): AuditRecord {
  const attributes: Record<string, string | number | boolean> = {};
  switch (event.type) {
    case "tool_call_started":
      attributes.toolName = event.call.name;
      break;
    case "tool_call_finished":
      attributes.status = event.result.status;
      if (event.result.error !== undefined) attributes.errorCode = event.result.error.code;
      break;
    case "permission_requested":
      attributes.toolName = event.toolName;
      break;
    case "permission_decided":
      attributes.toolName = event.toolName;
      attributes.decision = event.decision;
      if (event.scope !== undefined) attributes.scope = event.scope;
      break;
    case "usage":
      attributes.inputTokens = event.inputTokens;
      attributes.outputTokens = event.outputTokens;
      attributes.cachedInputTokens = event.cachedInputTokens ?? 0;
      break;
    case "provider_request_started":
      attributes.provider = event.provider;
      attributes.step = event.step;
      break;
    case "provider_response":
      attributes.provider = event.provider;
      attributes.finishReason = event.finishReason;
      break;
    case "error":
      attributes.category = event.category;
      attributes.retryable = event.retryable;
      break;
    case "turn_finished":
      attributes.reason = event.reason;
      break;
    case "turn_started":
    case "text_delta":
    case "reasoning_summary_delta":
      break;
  }
  return Object.freeze({
    protocolVersion: AUDIT_PROTOCOL_VERSION,
    sessionId,
    eventType: event.type,
    turnId: event.turnId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    attributes: Object.freeze(attributes),
  });
}

export function isAuditableRuntimeEvent(event: RuntimeEvent): boolean {
  return event.type !== "text_delta" && event.type !== "reasoning_summary_delta";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
