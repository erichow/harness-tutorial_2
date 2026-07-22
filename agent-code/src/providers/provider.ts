import type { ToolCallBlock } from "../messages/blocks.js";
import type { Transcript } from "../messages/transcript.js";
import type { ToolDefinition } from "../tools/executor.js";

export interface ProviderRequest {
  readonly transcript: Transcript;
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
}

export interface ProviderTextDelta {
  readonly type: "text_delta";
  readonly delta: string;
}

export interface ProviderReasoningSummaryDelta {
  readonly type: "reasoning_summary_delta";
  readonly delta: string;
}

export interface ProviderToolCall {
  readonly type: "tool_call";
  readonly call: ToolCallBlock;
}

export interface ProviderUsage {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
}

export interface ProviderResponseCompleted {
  readonly type: "response_completed";
  readonly finishReason: "stop" | "tool_calls";
  readonly requestId: string;
  readonly providerFinishReason: string;
}

export type ProviderStreamEvent =
  | ProviderTextDelta
  | ProviderReasoningSummaryDelta
  | ProviderToolCall
  | ProviderUsage
  | ProviderResponseCompleted;

export interface Provider {
  readonly name: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface ProviderErrorOptions extends ErrorOptions {
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly status?: number | undefined;
}

export class ProviderError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options);
    this.name = "ProviderError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
