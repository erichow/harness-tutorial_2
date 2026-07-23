import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { TestRunSummary } from "./test-loop.js";

export const RUNTIME_EVENT_PROTOCOL_VERSION = 1 as const;

interface EventBase {
  readonly protocolVersion: typeof RUNTIME_EVENT_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly turnId: string;
}

export interface TurnStartedEvent extends EventBase {
  readonly type: "turn_started";
}

export interface TextDeltaEvent extends EventBase {
  readonly type: "text_delta";
  readonly delta: string;
}

export interface ReasoningSummaryDeltaEvent extends EventBase {
  readonly type: "reasoning_summary_delta";
  readonly delta: string;
}

export interface ToolCallStartedEvent extends EventBase {
  readonly type: "tool_call_started";
  readonly call: ToolCallBlock;
}

export interface ToolCallFinishedEvent extends EventBase {
  readonly type: "tool_call_finished";
  readonly result: ToolResultBlock;
}

export interface PermissionRequestedEvent extends EventBase {
  readonly type: "permission_requested";
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: string;
}

export interface PermissionDecidedEvent extends EventBase {
  readonly type: "permission_decided";
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly decision: "allow" | "deny";
  readonly scope?: "once" | "session" | undefined;
  readonly reason: string;
}

export interface UsageEvent extends EventBase {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
}

export interface ProviderRequestStartedEvent extends EventBase {
  readonly type: "provider_request_started";
  readonly provider: string;
  readonly step: number;
}

export interface ProviderResponseEvent extends EventBase {
  readonly type: "provider_response";
  readonly provider: string;
  readonly requestId: string;
  readonly finishReason: string;
}

export type ErrorCategory =
  | "user"
  | "tool"
  | "provider"
  | "cancelled"
  | "internal";

export interface ErrorEvent extends EventBase {
  readonly type: "error";
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export type TurnFinishReason =
  | "completed"
  | "max_steps"
  | "max_duration"
  | "max_tokens"
  | "cancelled"
  | "error";

export interface TurnFinishedEvent extends EventBase {
  readonly type: "turn_finished";
  readonly reason: TurnFinishReason;
  /** Deterministic runtime summary; optional only for reading chapter 9-era events. */
  readonly tests?: TestRunSummary | undefined;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | TextDeltaEvent
  | ReasoningSummaryDeltaEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | PermissionRequestedEvent
  | PermissionDecidedEvent
  | UsageEvent
  | ProviderRequestStartedEvent
  | ProviderResponseEvent
  | ErrorEvent
  | TurnFinishedEvent;
