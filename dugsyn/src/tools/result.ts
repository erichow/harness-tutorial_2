import type { ToolResultBlock } from "../messages/blocks.js";
import type { JsonValue } from "../protocol/json.js";
import type { ToolHandlerOutput } from "./tool.js";

export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1_024;
export const MAX_TOOL_CURSOR_BYTES = 512;

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "permission_denied"
  | "execution_failed"
  | "repeated_call"
  | "limit_reached";

interface ResultOptions {
  readonly maxOutputBytes?: number | undefined;
}

interface ErrorResultOptions extends ResultOptions {
  readonly retryable?: boolean | undefined;
}

export function createToolSuccessResult(
  toolCallId: string,
  result: ToolHandlerOutput,
  options: ResultOptions = {},
): ToolResultBlock {
  const content = limitContent(
    result.content,
    options.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  );
  return {
    type: "tool_result",
    toolCallId,
    status: "success",
    content: content.value,
    ...(result.data === undefined ? {} : { data: result.data }),
    output: {
      contentBytes: content.contentBytes,
      totalContentBytes: content.totalContentBytes,
      truncated: content.truncated,
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    },
  };
}

export function createToolErrorResult(
  toolCallId: string,
  code: ToolErrorCode,
  message: string,
  options: ErrorResultOptions = {},
): ToolResultBlock {
  const content = limitContent(
    message,
    options.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  );
  return {
    type: "tool_result",
    toolCallId,
    status: "error",
    content: content.value,
    error: {
      code,
      message: content.value,
      retryable: options.retryable ?? false,
    },
    output: {
      contentBytes: content.contentBytes,
      totalContentBytes: content.totalContentBytes,
      truncated: content.truncated,
    },
  };
}

/** Serialize only the bounded, model-facing part of a result. */
export function serializeToolResultForProvider(result: ToolResultBlock): string {
  return JSON.stringify({
    status: result.status,
    content: result.content,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.output === undefined ? {} : { output: result.output }),
  });
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

function limitContent(value: string, maxBytes: number): {
  readonly value: string;
  readonly contentBytes: number;
  readonly totalContentBytes: number;
  readonly truncated: boolean;
} {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive integer");
  }

  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return {
      value,
      contentBytes: bytes.byteLength,
      totalContentBytes: bytes.byteLength,
      truncated: false,
    };
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  const bounded = new TextDecoder().decode(bytes.subarray(0, end));
  return {
    value: bounded,
    contentBytes: end,
    totalContentBytes: bytes.byteLength,
    truncated: true,
  };
}
