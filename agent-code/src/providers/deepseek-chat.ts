import type { ContentBlock, ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { TranscriptMessage } from "../messages/transcript.js";
import type { ToolDefinition } from "../tools/executor.js";
import { serializeToolResultForProvider } from "../tools/result.js";
import {
  isRecord,
  parseJsonObject,
  postJsonStream,
  readRequestId,
  type FetchLike,
} from "./http.js";
import {
  ProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "./provider.js";
import { decodeSse } from "./sse.js";

export interface DeepSeekChatProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly thinking?: "enabled" | "disabled" | undefined;
  readonly reasoningEffort?: "high" | "max" | undefined;
}

interface ChatToolCallAccumulator {
  readonly index: number;
  id: string;
  name: string;
  arguments: string;
}

export class DeepSeekChatProvider implements Provider {
  readonly name = "deepseek";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike | undefined;
  readonly #thinking: "enabled" | "disabled";
  readonly #reasoningEffort: "high" | "max" | undefined;
  #pendingReasoningContent: string | undefined;

  constructor(options: DeepSeekChatProviderOptions) {
    this.#apiKey = requireOption(options.apiKey, "apiKey");
    this.#model = requireOption(options.model, "model");
    this.#baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/u, "");
    this.#fetch = options.fetch;
    this.#thinking = options.thinking ?? "disabled";
    this.#reasoningEffort = options.reasoningEffort;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const body = {
      model: this.#model,
      messages: mapChatMessages(
        request.transcript.messages,
        this.#pendingReasoningContent,
      ),
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: this.#thinking },
      ...(request.tools.length === 0
        ? {}
        : { tools: request.tools.map(mapChatTool) }),
      ...(this.#reasoningEffort === undefined
        ? {}
        : { reasoning_effort: this.#reasoningEffort }),
    };
    const response = await postJsonStream({
      url: `${this.#baseUrl}/chat/completions`,
      apiKey: this.#apiKey,
      body,
      signal: request.signal,
      fetch: this.#fetch,
      provider: "DeepSeek",
    });

    const httpRequestId = readRequestId(response);
    let responseId: string | undefined;
    let finishReason: string | undefined;
    let usage: ProviderStreamEvent | undefined;
    let reasoningContent = "";
    let sawDone = false;
    const calls = new Map<number, ChatToolCallAccumulator>();

    try {
      for await (const data of decodeSse(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        const chunk = parseChunk(data);
        if (typeof chunk.id === "string") responseId = chunk.id;
        const chunkUsage = readDeepSeekUsage(chunk.usage);
        if (chunkUsage !== undefined) usage = chunkUsage;

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const rawChoice of choices) {
          if (!isRecord(rawChoice) || rawChoice.index !== 0) continue;
          const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", delta: delta.content };
          }
          if (typeof delta.reasoning_content === "string") {
            reasoningContent += delta.reasoning_content;
          }
          accumulateChatToolCalls(delta.tool_calls, calls);
          if (typeof rawChoice.finish_reason === "string") {
            finishReason = rawChoice.finish_reason;
          }
        }
      }
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`DeepSeek stream failed: ${message}`, {
        cause: error,
        requestId: httpRequestId ?? responseId,
      });
    }

    if (!sawDone) {
      throw new ProviderError("DeepSeek stream ended before data: [DONE]", {
        requestId: httpRequestId ?? responseId,
      });
    }
    if (responseId === undefined) {
      throw new ProviderError("DeepSeek stream did not include a response id", {
        requestId: httpRequestId,
      });
    }
    if (finishReason === undefined) {
      throw new ProviderError("DeepSeek stream did not include a finish_reason", {
        requestId: httpRequestId ?? responseId,
      });
    }
    if (finishReason !== "stop" && finishReason !== "tool_calls") {
      throw new ProviderError(`DeepSeek stopped with ${finishReason}`, {
        code: finishReason,
        requestId: httpRequestId ?? responseId,
        retryable: finishReason === "insufficient_system_resource",
      });
    }

    for (const call of [...calls.values()].sort((left, right) => left.index - right.index)) {
      yield {
        type: "tool_call",
        call: {
          type: "tool_call",
          id: requireAccumulated(call.id, "id", call.index),
          name: requireAccumulated(call.name, "name", call.index),
          input: parseJsonObject(
            call.arguments,
            `DeepSeek function ${call.name || call.index}`,
          ),
        },
      };
    }
    if (usage !== undefined) yield usage;
    yield {
      type: "response_completed",
      finishReason,
      requestId: httpRequestId ?? responseId,
      providerFinishReason: finishReason,
    };

    this.#pendingReasoningContent =
      finishReason === "tool_calls" && reasoningContent.length > 0
        ? reasoningContent
        : undefined;
  }
}

function mapChatTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function mapChatMessages(
  messages: readonly TranscriptMessage[],
  pendingReasoningContent: string | undefined,
): readonly Record<string, unknown>[] {
  const mapped: Record<string, unknown>[] = [];
  let reasoningInjected = false;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message === undefined) continue;
    if (message.role === "tool") {
      const results = message.content.filter(
        (block): block is ToolResultBlock => block.type === "tool_result",
      );
      mapped.unshift(
        ...results.map((result) => ({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: serializeToolResultForProvider(result),
        })),
      );
      continue;
    }

    const text = joinText(message.content);
    if (message.role === "assistant") {
      const calls = message.content.filter(
        (block): block is ToolCallBlock => block.type === "tool_call",
      );
      mapped.unshift({
        role: "assistant",
        content: text.length === 0 ? null : text,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            }),
        ...(!reasoningInjected &&
        calls.length > 0 &&
        pendingReasoningContent !== undefined
          ? { reasoning_content: pendingReasoningContent }
          : {}),
      });
      if (calls.length > 0 && pendingReasoningContent !== undefined) {
        reasoningInjected = true;
      }
      continue;
    }

    mapped.unshift({ role: message.role, content: text });
  }

  return mapped;
}

function joinText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function accumulateChatToolCalls(
  value: unknown,
  calls: Map<number, ChatToolCallAccumulator>,
): void {
  if (!Array.isArray(value)) return;
  for (const rawCall of value) {
    if (!isRecord(rawCall) || typeof rawCall.index !== "number") {
      throw new ProviderError("DeepSeek tool call delta is missing an index");
    }
    const existing = calls.get(rawCall.index) ?? {
      index: rawCall.index,
      id: "",
      name: "",
      arguments: "",
    };
    if (typeof rawCall.id === "string") existing.id += rawCall.id;
    if (isRecord(rawCall.function)) {
      if (typeof rawCall.function.name === "string") {
        existing.name += rawCall.function.name;
      }
      if (typeof rawCall.function.arguments === "string") {
        existing.arguments += rawCall.function.arguments;
      }
    }
    calls.set(rawCall.index, existing);
  }
}

function readDeepSeekUsage(value: unknown): ProviderStreamEvent | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new ProviderError("DeepSeek usage chunk is malformed");
  }
  return {
    type: "usage",
    inputTokens,
    outputTokens,
    ...(typeof value.prompt_cache_hit_tokens === "number"
      ? { cachedInputTokens: value.prompt_cache_hit_tokens }
      : {}),
  };
}

function parseChunk(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new ProviderError("DeepSeek stream chunk is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ProviderError("DeepSeek stream chunk must be an object");
  }
  if (isRecord(parsed.error)) {
    const message =
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : "DeepSeek stream returned an error";
    throw new ProviderError(message);
  }
  return parsed;
}

function requireAccumulated(value: string, field: string, index: number): string {
  if (value.length === 0) {
    throw new ProviderError(`DeepSeek tool call ${index} is missing ${field}`);
  }
  return value;
}

function requireOption(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`DeepSeekChatProvider ${name} must not be empty`);
  }
  return value;
}
