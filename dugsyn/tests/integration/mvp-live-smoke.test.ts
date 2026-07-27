import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createTranscript } from "../../src/messages/transcript.js";
import { DeepSeekChatProvider } from "../../src/providers/deepseek-chat.js";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.js";
import type { Provider } from "../../src/providers/provider.js";
import { CodingAgentRuntime } from "../../src/runtime/coding-agent.js";
import { PermissionEngine } from "../../src/security/permissions.js";
import { WorkspaceTrust } from "../../src/security/trust.js";
import { HostSandboxRunner } from "../../src/tools/shell/sandbox-runner.js";

const selected = process.env.MVP_LIVE_PROVIDER?.trim();
if (selected !== undefined && selected !== "openai" && selected !== "deepseek") {
  throw new Error("MVP_LIVE_PROVIDER must be openai or deepseek");
}

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(selected === undefined)("real-provider MVP smoke test", () => {
  it("completes the same search/read/patch/test contract", async () => {
    const provider = liveProvider(selected!);
    const root = await mkdtemp(join(tmpdir(), `dugsyn-${selected}-live-`));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "test"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "src/config.js"), "export const config = { timeout: 5000 };\n");
    await writeFile(join(root, "test/config.test.js"), [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { config } from "../src/config.js";',
      'test("timeout is 10000", () => assert.equal(config.timeout, 10000));',
      "",
    ].join("\n"));

    const trust = await WorkspaceTrust.create({ workspaceRoot: root, trustedRoots: [root] });
    const permissions = new PermissionEngine({ trust, defaultDecision: "allow" });
    const runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot: root,
      permissions,
      // This test is explicitly opt-in and runs only fixed local fixture commands.
      shell: { runner: new HostSandboxRunner() },
    });

    try {
      const result = await runtime.runTurn({
        transcript: createTranscript([{
          id: "live-user-1",
          role: "user",
          content: [{
            type: "text",
            text: [
              "Change timeout from 5000 to 10000 and run the test.",
              "You must use search_text, then read_file, then apply_patch with the returned SHA-256,",
              "then run_shell with: node --test test/config.test.js.",
              "Base the final answer on run_shell's real exitCode.",
            ].join(" "),
          }],
          createdAt: new Date().toISOString(),
        }]),
        signal: AbortSignal.timeout(180_000),
        limits: { maxSteps: 10 },
      });

      const shellResult = runtime.eventLog.entries.find(
        (event) => event.type === "tool_call_finished" &&
          event.result.status === "success" &&
          typeof event.result.data === "object" &&
          event.result.data !== null &&
          !Array.isArray(event.result.data) &&
          event.result.data.exitCode === 0,
      );
      if (result.reason !== "completed") {
        const attempts = runtime.eventLog.entries
          .filter((event) => event.type === "tool_call_finished")
          .map((event) => ({
            toolCallId: event.result.toolCallId,
            status: event.result.status,
            errorCode: event.result.error?.code,
            message: event.result.status === "error" ? event.result.content.slice(0, 800) : undefined,
          }));
        throw new Error(
          `Live MVP ended with ${result.reason} after ${result.steps} steps:\n${JSON.stringify(attempts, null, 2)}`,
        );
      }
      expect(await readFile(join(root, "src/config.js"), "utf8"))
        .toContain("timeout: 10000");
      expect(runtime.eventLog.fileChanges).toHaveLength(1);
      expect(shellResult).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 190_000);
});

function liveProvider(name: "openai" | "deepseek"): Provider {
  const keyName = name === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  const modelName = name === "openai" ? "OPENAI_MODEL" : "DEEPSEEK_MODEL";
  const apiKey = process.env[keyName]?.trim();
  const model = process.env[modelName]?.trim();
  if (apiKey === undefined || apiKey.length === 0 || model === undefined || model.length === 0) {
    throw new Error(`${keyName} and ${modelName} are required for the ${name} MVP smoke test`);
  }
  return name === "openai"
    ? new OpenAIResponsesProvider({ apiKey, model })
    : new DeepSeekChatProvider({ apiKey, model });
}
