import { describe, expect, it } from "vitest";

import { createTranscript } from "../../src/messages/transcript.js";
import { DeepSeekChatProvider } from "../../src/providers/deepseek-chat.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";
import type { Provider } from "../../src/providers/provider.js";

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

const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL;

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
  },
);

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekModel = process.env.DEEPSEEK_MODEL;

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
  },
);
