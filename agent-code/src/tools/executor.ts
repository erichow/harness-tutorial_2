import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { JsonObject } from "../protocol/json.js";
import {
  createToolErrorResult,
  createToolSuccessResult,
} from "./result.js";
import type { ToolDefinition, ToolHandlerOutput } from "./tool.js";

export type { ToolDefinition } from "./tool.js";

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export interface ToolImplementation {
  readonly definition: ToolDefinition;
  /** Return an error message when the input is invalid. */
  validate?(input: JsonObject): string | undefined;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolHandlerOutput>;
}

export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  execute(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResultBlock>;
}

/**
 * A deliberately small executor for the first agent loop. Chapter 5 extends this
 * boundary with runtime schemas, permissions, and stable result envelopes.
 */
export class InMemoryToolExecutor implements ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  readonly #tools: ReadonlyMap<string, ToolImplementation>;

  constructor(tools: readonly ToolImplementation[]) {
    const byName = new Map<string, ToolImplementation>();
    for (const tool of tools) {
      if (byName.has(tool.definition.name)) {
        throw new Error(`Duplicate tool: ${tool.definition.name}`);
      }
      byName.set(tool.definition.name, tool);
    }

    this.#tools = byName;
    this.definitions = tools.map((tool) => tool.definition);
  }

  async execute(
    call: ToolCallBlock,
    context: ToolExecutionContext,
  ): Promise<ToolResultBlock> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return createToolErrorResult(call.id, "unknown_tool", `Unknown tool: ${call.name}`);
    }

    const validationError = tool.validate?.(call.input);
    if (validationError !== undefined) {
      return createToolErrorResult(call.id, "invalid_arguments", validationError);
    }

    try {
      const result = await tool.execute(call.input, context);
      return createToolSuccessResult(call.id, result);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return createToolErrorResult(
        call.id,
        "execution_failed",
        `Tool ${call.name} failed: ${message}`,
      );
    }
  }
}
