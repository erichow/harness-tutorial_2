import { describe, expect, it } from "vitest";

import { createTranscript } from "../../src/messages/transcript.js";
import { DeepSeekChatProvider } from "../../src/providers/deepseek-chat.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";
import type { Provider } from "../../src/providers/provider.js";
import { runTurn } from "../../src/runtime/agent.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { InMemoryToolExecutor } from "../../src/tools/executor.js";

const transcript = createTranscript([
  {
    id: "smoke-user-message",
    role: "user",
    content: [{ type: "text", text: "Reply with exactly: smoke-ok" }],
    createdAt: new Date().toISOString(),
  },
]);

async function readText(provider: Provider): Promise<string> {
  let text = "";
  for await (const event of provider.stream({
    transcript,
    tools: [],
    signal: AbortSignal.timeout(120_000),
  })) {
    if (event.type === "text_delta") text += event.delta;
  }
  return text;
}

async function runToolRoundTrip(provider: Provider): Promise<void> {
  const events: RuntimeEvent[] = [];
  let executions = 0;
  const tools = new InMemoryToolExecutor([
    {
      definition: {
        name: "live_smoke",
        description: "Return the fixed marker used by the live integration test.",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string", enum: ["ping"] },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
      validate(input) {
        return input.value === "ping" ? undefined : "value must be ping";
      },
      async execute() {
        executions += 1;
        return { content: "tool-ok", data: { marker: "tool-ok" } };
      },
    },
  ]);

  const result = await runTurn({
    provider,
    transcript: createTranscript([
      {
        id: "smoke-tool-user-message",
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "This is an integration test.",
              "Call live_smoke exactly once with {\"value\":\"ping\"}.",
              "After receiving its result, do not call another tool and reply exactly: tool-ok",
            ].join(" "),
          },
        ],
        createdAt: new Date().toISOString(),
      },
    ]),
    tools,
    signal: AbortSignal.timeout(120_000),
    limits: { maxSteps: 4 },
    emit(event) {
      events.push(event);
    },
  });

  if (result.reason !== "completed") {
    const error = events.find(
      (event): event is Extract<RuntimeEvent, { type: "error" }> =>
        event.type === "error",
    );
    throw new Error(`Live tool round trip failed: ${error?.message ?? result.reason}`);
  }
  expect(executions).toBe(1);

  const finalMessage = result.transcript.messages.at(-1);
  expect(finalMessage?.role).toBe("assistant");
  expect(
    finalMessage?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
  ).toContain("tool-ok");

  expect(events.some((event) => event.type === "tool_call_started")).toBe(true);
  expect(events.some((event) => event.type === "tool_call_finished")).toBe(true);
  expect(events.some((event) => event.type === "usage")).toBe(true);

  const providerResponses = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "provider_response" }> =>
      event.type === "provider_response",
  );
  expect(providerResponses).toHaveLength(2);
  expect(providerResponses.map((event) => event.finishReason)).toEqual([
    "tool_calls",
    "stop",
  ]);
  expect(providerResponses.every((event) => event.requestId.length > 0)).toBe(true);
}

const openaiApiKey = nonEmptyEnvironmentValue("OPENAI_API_KEY");
const openaiModel = nonEmptyEnvironmentValue("OPENAI_MODEL");

describe.skipIf(openaiApiKey === undefined || openaiModel === undefined)(
  "OpenAI live smoke test",
  () => {
    it("streams a text response", async () => {
      const provider = new OpenAIResponsesProvider({
        apiKey: openaiApiKey!,
        model: openaiModel!,
      });

      expect(await readText(provider)).toContain("smoke-ok");
    }, 130_000);

    it("completes a tool call round trip", async () => {
      const provider = new OpenAIResponsesProvider({
        apiKey: openaiApiKey!,
        model: openaiModel!,
      });

      await runToolRoundTrip(provider);
    }, 130_000);
  },
);

const deepseekApiKey = nonEmptyEnvironmentValue("DEEPSEEK_API_KEY");
const deepseekModel = nonEmptyEnvironmentValue("DEEPSEEK_MODEL");

describe.skipIf(deepseekApiKey === undefined || deepseekModel === undefined)(
  "DeepSeek live smoke test",
  () => {
    it("streams a text response", async () => {
      const provider = new DeepSeekChatProvider({
        apiKey: deepseekApiKey!,
        model: deepseekModel!,
      });

      expect(await readText(provider)).toContain("smoke-ok");
    }, 130_000);

    it("completes a tool call round trip", async () => {
      const provider = new DeepSeekChatProvider({
        apiKey: deepseekApiKey!,
        model: deepseekModel!,
      });

      await runToolRoundTrip(provider);
    }, 130_000);
  },
);

function nonEmptyEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
