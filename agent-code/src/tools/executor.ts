import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { JsonObject, JsonValue } from "../protocol/json.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export interface ToolSuccess {
  readonly content: string;
  readonly data?: JsonValue | undefined;
}

export interface ToolImplementation {
  readonly definition: ToolDefinition;
  /** Return an error message when the input is invalid. */
  validate?(input: JsonObject): string | undefined;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolSuccess>;
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
      return toolError(call.id, "unknown_tool", `Unknown tool: ${call.name}`);
    }

    const validationError = tool.validate?.(call.input);
    if (validationError !== undefined) {
      return toolError(call.id, "invalid_arguments", validationError);
    }

    try {
      const result = await tool.execute(call.input, context);
      return {
        type: "tool_result",
        toolCallId: call.id,
        status: "success",
        content: result.content,
        ...(result.data === undefined ? {} : { data: result.data }),
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolError(call.id, "execution_failed", `Tool ${call.name} failed: ${message}`);
    }
  }
}

function toolError(
  toolCallId: string,
  code: "unknown_tool" | "invalid_arguments" | "execution_failed",
  content: string,
): ToolResultBlock {
  return {
    type: "tool_result",
    toolCallId,
    status: "error",
    content,
    data: { code },
  };
}
