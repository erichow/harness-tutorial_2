import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { JsonObject, JsonValue } from "../protocol/json.js";
import type { PermissionEngine } from "../security/permissions.js";
import type { ToolExecutionContext, ToolExecutor } from "./executor.js";
import {
  createToolErrorResult,
  createToolSuccessResult,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  isJsonValue,
  MAX_TOOL_CURSOR_BYTES,
} from "./result.js";
import type { Tool, ToolDefinition, ToolHandlerOutput } from "./tool.js";

export interface ToolRegistryOptions {
  readonly maxOutputBytes?: number | undefined;
  /** Maximum executions of the same tool + canonical input in one executor. */
  readonly maxIdenticalCalls?: number | undefined;
  readonly permissions?: PermissionEngine | undefined;
}

interface RegisteredTool {
  readonly tool: Tool;
  readonly validate: ValidateFunction<JsonObject>;
}

export class ToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  readonly #tools: ReadonlyMap<string, RegisteredTool>;
  readonly #maxOutputBytes: number;
  readonly #maxIdenticalCalls: number;
  readonly #permissions: PermissionEngine | undefined;

  constructor(tools: readonly Tool[], options: ToolRegistryOptions = {}) {
    this.#maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#maxIdenticalCalls = positiveInteger(
      options.maxIdenticalCalls ?? 3,
      "maxIdenticalCalls",
    );
    this.#permissions = options.permissions;

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const registered = new Map<string, RegisteredTool>();
    for (const tool of tools) {
      validateToolDefinition(tool, registered);
      const inputSchema = structuredClone(tool.definition.inputSchema);
      let validate: ValidateFunction<JsonObject>;
      try {
        validate = ajv.compile<JsonObject>(inputSchema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Invalid schema for tool ${tool.definition.name}: ${message}`, {
          cause: error,
        });
      }
      freezeJson(inputSchema);
      const registeredTool: Tool = Object.freeze({
        definition: Object.freeze({
          name: tool.definition.name,
          description: tool.definition.description,
          inputSchema,
        }),
        sideEffects: Object.freeze([...tool.sideEffects]),
        handler: tool.handler,
      });
      registered.set(tool.definition.name, { tool: registeredTool, validate });
    }

    this.#tools = registered;
    this.definitions = Object.freeze(
      [...registered.values()].map(({ tool }) => tool.definition),
    );
  }

  /** A fresh executor gives loop detection turn-local state. */
  createExecutor(): ToolExecutor {
    const callCounts = new Map<string, number>();
    return {
      definitions: this.definitions,
      execute: async (call, context) =>
        await this.#execute(call, context, callCounts),
    };
  }

  getSideEffects(name: string): Tool["sideEffects"] | undefined {
    return this.#tools.get(name)?.tool.sideEffects;
  }

  async #execute(
    call: ToolCallBlock,
    context: ToolExecutionContext,
    callCounts: Map<string, number>,
  ): Promise<ToolResultBlock> {
    const registered = this.#tools.get(call.name);
    if (registered === undefined) {
      return createToolErrorResult(
        call.id,
        "unknown_tool",
        `Unknown tool: ${call.name}`,
        { maxOutputBytes: this.#maxOutputBytes },
      );
    }

    if (!registered.validate(call.input)) {
      return createToolErrorResult(
        call.id,
        "invalid_arguments",
        `Invalid arguments for ${call.name}: ${formatValidationErrors(registered.validate.errors)}`,
        { maxOutputBytes: this.#maxOutputBytes },
      );
    }

    if (this.#permissions !== undefined) {
      const decision = await this.#permissions.authorize({
        toolName: call.name,
        input: call.input,
        sideEffects: registered.tool.sideEffects,
      }, context.signal);
      if (decision.kind !== "allow") {
        return createToolErrorResult(
          call.id,
          "permission_denied",
          `Permission denied for ${call.name}: ${decision.reason}`,
          { maxOutputBytes: this.#maxOutputBytes },
        );
      }
    }

    const signature = `${call.name}:${canonicalJson(call.input)}`;
    const count = (callCounts.get(signature) ?? 0) + 1;
    callCounts.set(signature, count);
    if (count > this.#maxIdenticalCalls) {
      return createToolErrorResult(
        call.id,
        "repeated_call",
        `Repeated tool call blocked: ${call.name} received the same input more than ${this.#maxIdenticalCalls} times in this turn.`,
        { maxOutputBytes: this.#maxOutputBytes },
      );
    }

    try {
      const output: unknown = await registered.tool.handler(call.input, {
        signal: context.signal,
        maxOutputBytes: this.#maxOutputBytes,
      });
      assertHandlerOutput(output, call.name);
      return createToolSuccessResult(call.id, output, {
        maxOutputBytes: this.#maxOutputBytes,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return createToolErrorResult(
        call.id,
        "execution_failed",
        `Tool ${call.name} failed: ${message}`,
        { maxOutputBytes: this.#maxOutputBytes },
      );
    }
  }
}

function validateToolDefinition(
  tool: Tool,
  registered: ReadonlyMap<string, RegisteredTool>,
): void {
  const { name, description } = tool.definition;
  if (name.trim().length === 0) throw new TypeError("Tool name must not be empty");
  if (description.trim().length === 0) {
    throw new TypeError(`Tool ${name} description must not be empty`);
  }
  if (registered.has(name)) throw new TypeError(`Duplicate tool: ${name}`);
  if (new Set(tool.sideEffects).size !== tool.sideEffects.length) {
    throw new TypeError(`Tool ${name} contains duplicate side effects`);
  }
}

function assertHandlerOutput(
  value: unknown,
  toolName: string,
): asserts value is ToolHandlerOutput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Tool ${toolName} returned a non-object result`);
  }
  const output = value as Record<string, unknown>;
  if (typeof output.content !== "string") {
    throw new TypeError(`Tool ${toolName} result content must be a string`);
  }
  if (output.data !== undefined && !isJsonValue(output.data)) {
    throw new TypeError(`Tool ${toolName} result data must be JSON-compatible`);
  }
  if (
    output.nextCursor !== undefined &&
    (typeof output.nextCursor !== "string" || output.nextCursor.length === 0)
  ) {
    throw new TypeError(`Tool ${toolName} nextCursor must be a non-empty string`);
  }
  if (
    typeof output.nextCursor === "string" &&
    new TextEncoder().encode(output.nextCursor).byteLength > MAX_TOOL_CURSOR_BYTES
  ) {
    throw new TypeError(
      `Tool ${toolName} nextCursor exceeds ${MAX_TOOL_CURSOR_BYTES} bytes`,
    );
  }
}

function formatValidationErrors(
  errors: readonly ErrorObject[] | null | undefined,
): string {
  if (errors === undefined || errors === null || errors.length === 0) {
    return "input does not match the JSON Schema";
  }
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
    .join("; ");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function freezeJson(value: JsonValue): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
