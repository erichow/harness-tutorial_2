import type { JsonObject, JsonValue } from "../protocol/json.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type ToolSideEffect =
  | "read_workspace"
  | "write_workspace"
  | "execute_process"
  | "network";

export interface ToolHandlerContext {
  readonly signal: AbortSignal;
  /** Handlers that support pagination should keep each page within this limit. */
  readonly maxOutputBytes: number;
}

export interface ToolHandlerOutput {
  readonly content: string;
  readonly data?: JsonValue | undefined;
  /** Opaque cursor understood by this tool's input schema and handler. */
  readonly nextCursor?: string | undefined;
}

export interface Tool {
  readonly definition: ToolDefinition;
  readonly sideEffects: readonly ToolSideEffect[];
  readonly handler: (
    input: JsonObject,
    context: ToolHandlerContext,
  ) => Promise<ToolHandlerOutput>;
}
