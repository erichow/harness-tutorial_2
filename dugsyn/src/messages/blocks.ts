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
  /** Present on results produced by the chapter 5 Tool Registry. */
  readonly error?: ToolResultError | undefined;
  /** Output accounting is optional so chapter 2-4 transcripts remain readable. */
  readonly output?: ToolResultOutput | undefined;
}

export interface ToolResultError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolResultOutput {
  readonly contentBytes: number;
  readonly totalContentBytes: number;
  readonly truncated: boolean;
  /** Opaque, tool-owned cursor to pass to a later invocation. */
  readonly nextCursor?: string | undefined;
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
