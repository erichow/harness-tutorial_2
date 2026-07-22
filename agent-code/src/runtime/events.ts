import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";

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

export interface UsageEvent extends EventBase {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
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

export type TurnFinishReason = "completed" | "max_steps" | "cancelled" | "error";

export interface TurnFinishedEvent extends EventBase {
  readonly type: "turn_finished";
  readonly reason: TurnFinishReason;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | TextDeltaEvent
  | ReasoningSummaryDeltaEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | PermissionRequestedEvent
  | UsageEvent
  | ErrorEvent
  | TurnFinishedEvent;
