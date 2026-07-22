import type { JsonObject, JsonValue } from "../protocol/json.js";

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolCallBlock {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly status: "success" | "error";
  /** Stable text suitable for returning to a model. */
  readonly content: string;
  /** Optional structured data for renderers, logs, and automation. */
  readonly data?: JsonValue | undefined;
}

export interface ReasoningSummaryBlock {
  readonly type: "reasoning_summary";
  readonly text: string;
}

export type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningSummaryBlock;
