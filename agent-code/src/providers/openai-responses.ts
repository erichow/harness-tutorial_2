import type { ContentBlock } from "../messages/blocks.js";
import type { Transcript, TranscriptMessage } from "../messages/transcript.js";
import type { ToolDefinition } from "../tools/executor.js";
import {
  isRecord,
  parseJsonObject,
  postJsonStream,
  readRequestId,
  requireString,
  type FetchLike,
} from "./http.js";
import {
  ProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "./provider.js";
import { decodeSse } from "./sse.js";

export interface OpenAIResponsesProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly reasoning?:
    | {
        readonly effort?: string | undefined;
        readonly summary?: "auto" | "concise" | "detailed" | undefined;
      }
    | undefined;
}

interface FunctionCallAccumulator {
  readonly callId: string;
  readonly itemId: string;
  readonly name: string;
  arguments: string;
  emitted: boolean;
}

export class OpenAIResponsesProvider implements Provider {
  readonly name = "openai";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike | undefined;
  readonly #reasoning: OpenAIResponsesProviderOptions["reasoning"];
  #previousResponseId: string | undefined;
  #knownTranscriptLength = 0;
  #knownPrefixIds: readonly string[] = [];

  constructor(options: OpenAIResponsesProviderOptions) {
    this.#apiKey = requireOption(options.apiKey, "apiKey");
    this.#model = requireOption(options.model, "model");
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
    this.#fetch = options.fetch;
    this.#reasoning = options.reasoning;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const continuation = this.#canContinue(request.transcript);
    const inputMessages = continuation
      ? request.transcript.messages.slice(this.#knownTranscriptLength)
      : request.transcript.messages;
    const body = {
      model: this.#model,
      input: mapResponsesInput(inputMessages),
      stream: true,
      store: true,
      ...(request.tools.length === 0
        ? {}
        : { tools: request.tools.map(mapResponsesTool) }),
      ...(continuation && this.#previousResponseId !== undefined
        ? { previous_response_id: this.#previousResponseId }
        : {}),
      ...(this.#reasoning === undefined ? {} : { reasoning: this.#reasoning }),
    };
    const response = await postJsonStream({
      url: `${this.#baseUrl}/responses`,
      apiKey: this.#apiKey,
      body,
      signal: request.signal,
      fetch: this.#fetch,
      provider: "OpenAI",
    });

    const httpRequestId = readRequestId(response);
    let responseId: string | undefined;
    let completed = false;
    let sawToolCall = false;
    const calls = new Map<string, FunctionCallAccumulator>();

    try {
      for await (const data of decodeSse(response.body)) {
        if (data === "[DONE]") break;
        const event = parseEvent(data, "OpenAI Responses stream event");
        const type = requireString(event.type, "type", "OpenAI Responses event");

        switch (type) {
          case "response.created": {
            const responseObject = requireRecord(event.response, "response", type);
            responseId = requireString(responseObject.id, "id", type);
            break;
          }
          case "response.output_text.delta":
            yield {
              type: "text_delta",
              delta: requireString(event.delta, "delta", type),
            };
            break;
          case "response.reasoning_summary_text.delta":
            yield {
              type: "reasoning_summary_delta",
              delta: requireString(event.delta, "delta", type),
            };
            break;
          case "response.output_item.added": {
            const item = requireRecord(event.item, "item", type);
            if (item.type !== "function_call") break;
            const itemId = requireString(item.id, "item.id", type);
            calls.set(itemId, {
              itemId,
              callId: requireString(item.call_id, "item.call_id", type),
              name: requireString(item.name, "item.name", type),
              arguments: typeof item.arguments === "string" ? item.arguments : "",
              emitted: false,
            });
            break;
          }
          case "response.function_call_arguments.delta": {
            const itemId = requireString(event.item_id, "item_id", type);
            const call = calls.get(itemId);
            if (call === undefined) {
              throw new ProviderError(`OpenAI sent arguments for unknown item ${itemId}`);
            }
            call.arguments += requireString(event.delta, "delta", type);
            break;
          }
          case "response.function_call_arguments.done": {
            const itemId = requireString(event.item_id, "item_id", type);
            const call = calls.get(itemId);
            if (call === undefined) {
              throw new ProviderError(`OpenAI completed unknown function item ${itemId}`);
            }
            call.arguments = requireString(event.arguments, "arguments", type);
            break;
          }
          case "response.output_item.done": {
            const item = requireRecord(event.item, "item", type);
            if (item.type !== "function_call") break;
            const itemId = requireString(item.id, "item.id", type);
            const existing = calls.get(itemId);
            const call: FunctionCallAccumulator = existing ?? {
              itemId,
              callId: requireString(item.call_id, "item.call_id", type),
              name: requireString(item.name, "item.name", type),
              arguments: requireString(item.arguments, "item.arguments", type),
              emitted: false,
            };
            call.arguments = requireString(item.arguments, "item.arguments", type);
            calls.set(itemId, call);
            break;
          }
          case "response.completed": {
            const responseObject = requireRecord(event.response, "response", type);
            const completedResponseId = requireString(
              responseObject.id,
              "response.id",
              type,
            );
            responseId = completedResponseId;
            for (const call of calls.values()) {
              if (!call.emitted) {
                yield toToolCall(call);
                call.emitted = true;
                sawToolCall = true;
              }
            }
            const usage = readOpenAIUsage(responseObject.usage);
            if (usage !== undefined) yield usage;
            yield {
              type: "response_completed",
              finishReason: sawToolCall ? "tool_calls" : "stop",
              requestId: httpRequestId ?? completedResponseId,
              providerFinishReason: requireString(
                responseObject.status,
                "response.status",
                type,
              ),
            };
            this.#previousResponseId = completedResponseId;
            this.#knownTranscriptLength = request.transcript.messages.length + 1;
            this.#knownPrefixIds = request.transcript.messages.map((message) => message.id);
            completed = true;
            break;
          }
          case "response.failed":
          case "response.incomplete": {
            const responseObject = requireRecord(event.response, "response", type);
            const responseError = isRecord(responseObject.error)
              ? responseObject.error.message
              : undefined;
            const detail =
              typeof responseError === "string" ? responseError : `OpenAI ${type}`;
            throw new ProviderError(detail, {
              requestId:
                httpRequestId ??
                (typeof responseObject.id === "string"
                  ? responseObject.id
                  : responseId),
            });
          }
          case "error":
            throw new ProviderError(readStreamError(event), {
              requestId: httpRequestId ?? responseId,
            });
          default:
            // The Responses API has many lifecycle events. Unknown non-terminal
            // events are ignored so the adapter only owns its declared contract.
            break;
        }
      }
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`OpenAI stream failed: ${message}`, {
        cause: error,
        requestId: httpRequestId ?? responseId,
      });
    }

    if (!completed) {
      throw new ProviderError("OpenAI stream ended before response.completed", {
        requestId: httpRequestId ?? responseId,
        retryable: false,
      });
    }
  }

  #canContinue(transcript: Transcript): boolean {
    if (
      this.#previousResponseId === undefined ||
      transcript.messages.length < this.#knownTranscriptLength ||
      transcript.messages[this.#knownTranscriptLength - 1]?.role !== "assistant"
    ) {
      return false;
    }
    return this.#knownPrefixIds.every(
      (id, index) => transcript.messages[index]?.id === id,
    );
  }
}

function mapResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function mapResponsesInput(
  messages: readonly TranscriptMessage[],
): readonly Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.length > 0 && message.role !== "tool") {
      input.push({ role: message.role, content: text });
    }
    for (const block of message.content) {
      if (block.type === "tool_call") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: block.content,
        });
      }
    }
  }
  return input;
}

function toToolCall(call: FunctionCallAccumulator): ProviderStreamEvent {
  return {
    type: "tool_call",
    call: {
      type: "tool_call",
      id: call.callId,
      name: call.name,
      input: parseJsonObject(call.arguments, `OpenAI function ${call.name}`),
    },
  };
}

function readOpenAIUsage(value: unknown): ProviderStreamEvent | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new ProviderError("OpenAI response usage is malformed");
  }
  const details = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const cached = details?.cached_tokens;
  return {
    type: "usage",
    inputTokens,
    outputTokens,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
  };
}

function parseEvent(data: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new ProviderError(`${context} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new ProviderError(`${context} must be an object`);
  return parsed;
}

function requireRecord(
  value: unknown,
  field: string,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderError(`${context} is missing object field ${field}`);
  return value;
}

function readStreamError(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") {
    return event.error.message;
  }
  return "OpenAI stream returned an error event";
}

function requireOption(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`OpenAIResponsesProvider ${name} must not be empty`);
  }
  return value;
}
