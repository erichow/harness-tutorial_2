import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ToolCallBlock } from "../../src/messages/blocks.js";
import { createTranscript, type Transcript } from "../../src/messages/transcript.js";
import { DeepSeekChatProvider } from "../../src/providers/deepseek-chat.js";
import type { FetchLike } from "../../src/providers/http.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";
import {
  ProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../../src/providers/provider.js";
import { runTurn } from "../../src/runtime/agent.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { InMemoryToolExecutor, type ToolDefinition } from "../../src/tools/executor.js";

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Get weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

const userTranscript = createTranscript([
  {
    id: "message-user",
    role: "user",
    content: [{ type: "text", text: "What is the weather in Shenzhen?" }],
    createdAt: "2026-07-22T12:00:00.000Z",
  },
]);

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function recordedFetch(fixtures: readonly string[]): {
  readonly fetch: FetchLike;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let next = 0;
  return {
    requests,
    async fetch(url, init) {
      const fixture = fixtures[next];
      next += 1;
      if (fixture === undefined) throw new Error(`No HTTP fixture at index ${next - 1}`);
      requests.push({
        url,
        init,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(fixture, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": `header-request-${next - 1}`,
        },
      });
    },
  };
}

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(`../fixtures/providers/${name}`, import.meta.url), "utf8");
}

async function collect(
  provider: Provider,
  transcript: Transcript = userTranscript,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  const request: ProviderRequest = {
    transcript,
    tools: [weatherTool],
    signal: new AbortController().signal,
  };
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

describe.each([
  {
    name: "OpenAI Responses",
    fixtureName: "openai-tool-call.sse",
    create(fetch: FetchLike) {
      return new OpenAIResponsesProvider({
        apiKey: "test-openai-key",
        model: "test-gpt-model",
        fetch,
      });
    },
  },
  {
    name: "DeepSeek Chat Completions",
    fixtureName: "deepseek-tool-call.sse",
    create(fetch: FetchLike) {
      return new DeepSeekChatProvider({
        apiKey: "test-deepseek-key",
        model: "test-deepseek-model",
        fetch,
      });
    },
  },
])("$name provider contract", ({ fixtureName, create }) => {
  it("normalizes fragmented tool arguments, usage, and completion metadata", async () => {
    const transport = recordedFetch([await fixture(fixtureName)]);
    const events = await collect(create(transport.fetch));

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "tool_call",
      "usage",
      "response_completed",
    ]);
    expect(events[0]).toEqual({ type: "text_delta", delta: "Checking " });
    expect(events[1]).toEqual({
      type: "tool_call",
      call: {
        type: "tool_call",
        id: "call_weather",
        name: "get_weather",
        input: { city: "Shenzhen" },
      },
    });
    expect(events[2]).toEqual({
      type: "usage",
      inputTokens: 30,
      outputTokens: 8,
      cachedInputTokens: 4,
    });
    expect(events[3]).toMatchObject({
      type: "response_completed",
      finishReason: "tool_calls",
      requestId: expect.any(String),
      providerFinishReason: expect.any(String),
    });
  });
});

describe("OpenAIResponsesProvider", () => {
  it("uses Responses request shapes and previous_response_id for a tool continuation", async () => {
    const transport = recordedFetch([
      await fixture("openai-tool-call.sse"),
      await fixture("openai-text.sse"),
    ]);
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-openai-key",
      model: "custom-gpt-model",
      reasoning: { effort: "medium", summary: "auto" },
      fetch: transport.fetch,
    });
    const first = await collect(provider);
    const callEvent = first.find((event) => event.type === "tool_call");
    if (callEvent?.type !== "tool_call") throw new Error("Expected a tool call");
    const call: ToolCallBlock = callEvent.call;

    const continued = createTranscript([
      ...userTranscript.messages,
      {
        id: "message-assistant-tool",
        role: "assistant",
        content: [call],
        createdAt: "2026-07-22T12:00:01.000Z",
      },
      {
        id: "message-tool-result",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_weather",
            status: "success",
            content: "sunny",
          },
        ],
        createdAt: "2026-07-22T12:00:02.000Z",
      },
    ]);
    const second = await collect(provider, continued);

    expect(transport.requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(transport.requests[0]?.body).toMatchObject({
      model: "custom-gpt-model",
      stream: true,
      store: true,
      reasoning: { effort: "medium", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: weatherTool.inputSchema,
        },
      ],
    });
    expect(transport.requests[1]?.body).toMatchObject({
      previous_response_id: "resp_openai_tool",
      input: [
        {
          type: "function_call_output",
          call_id: "call_weather",
          output: "{\"status\":\"success\",\"content\":\"sunny\"}",
        },
      ],
    });
    expect(second).toContainEqual({
      type: "reasoning_summary_delta",
      delta: "Use the tool result.",
    });
    expect(second.at(-1)).toMatchObject({
      type: "response_completed",
      finishReason: "stop",
      requestId: "header-request-1",
    });
  });

  it("classifies rate limits without exposing the API key", async () => {
    const apiKey = "super-secret-openai-key";
    const fetch: FetchLike = async () => new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      { status: 429, headers: { "x-request-id": "req_rate_limit" } },
    );
    const provider = new OpenAIResponsesProvider({
      apiKey,
      model: "test-gpt-model",
      fetch,
    });

    let caught: unknown;
    try {
      await collect(provider);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      status: 429,
      retryable: true,
      requestId: "req_rate_limit",
    });
    expect(String(caught)).not.toContain(apiKey);
  });
});

describe("DeepSeekChatProvider", () => {
  it("uses compatible Chat Completions shapes and keeps raw reasoning private", async () => {
    const transport = recordedFetch([
      await fixture("deepseek-tool-call.sse"),
      await fixture("deepseek-text.sse"),
    ]);
    const provider = new DeepSeekChatProvider({
      apiKey: "test-deepseek-key",
      model: "custom-deepseek-model",
      thinking: "enabled",
      reasoningEffort: "high",
      fetch: transport.fetch,
    });
    const first = await collect(provider);
    const callEvent = first.find((event) => event.type === "tool_call");
    if (callEvent?.type !== "tool_call") throw new Error("Expected a tool call");
    const continued = createTranscript([
      ...userTranscript.messages,
      {
        id: "message-assistant-tool",
        role: "assistant",
        content: [callEvent.call],
        createdAt: "2026-07-22T12:00:01.000Z",
      },
      {
        id: "message-tool-result",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_weather",
            status: "success",
            content: "sunny",
          },
        ],
        createdAt: "2026-07-22T12:00:02.000Z",
      },
    ]);
    const second = await collect(provider, continued);

    expect(transport.requests[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(transport.requests[0]?.body).toMatchObject({
      model: "custom-deepseek-model",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: weatherTool.inputSchema,
          },
        },
      ],
    });
    const messages = transport.requests[1]?.body.messages;
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "raw private reasoning",
      }),
      {
        role: "tool",
        tool_call_id: "call_weather",
        content: "{\"status\":\"success\",\"content\":\"sunny\"}",
      },
    ]));
    expect([...first, ...second].some(
      (event) => event.type === "reasoning_summary_delta" && event.delta.includes("raw private"),
    )).toBe(false);
  });
});

describe.each([
  {
    name: "OpenAI",
    fixtureName: "openai-truncated.sse",
    create(fetch: FetchLike) {
      return new OpenAIResponsesProvider({
        apiKey: "test-openai-key",
        model: "test-gpt-model",
        fetch,
      });
    },
  },
  {
    name: "DeepSeek",
    fixtureName: "deepseek-truncated.sse",
    create(fetch: FetchLike) {
      return new DeepSeekChatProvider({
        apiKey: "test-deepseek-key",
        model: "test-deepseek-model",
        fetch,
      });
    },
  },
])("$name interrupted stream", ({ fixtureName, create }) => {
  it("keeps already emitted text in the transcript and returns an explicit error", async () => {
    const transport = recordedFetch([await fixture(fixtureName)]);
    const events: RuntimeEvent[] = [];
    const result = await runTurn({
      provider: create(transport.fetch),
      transcript: userTranscript,
      tools: new InMemoryToolExecutor([]),
      emit(event) {
        events.push(event);
      },
    });

    expect(result.reason).toBe("error");
    expect(result.transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
    });
    expect(events.slice(-2)).toMatchObject([
      { type: "error", category: "provider" },
      { type: "turn_finished", reason: "error" },
    ]);
  });
});
