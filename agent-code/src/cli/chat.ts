import { resolve } from "node:path";

import { createPlatformSandboxRunner } from "../tools/shell/sandbox-runner.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses.js";
import { DeepSeekChatProvider } from "../providers/deepseek-chat.js";
import type { Provider } from "../providers/provider.js";
import { CodingAgentRuntime } from "../runtime/coding-agent.js";
import { PermissionEngine } from "../security/permissions.js";
import { WorkspaceTrust } from "../security/trust.js";
import { NodeInputController } from "./input.js";
import { createTerminalPermissionHandler } from "./permission-prompt.js";
import { TerminalRenderer } from "./renderer.js";
import { CliSession } from "./session.js";

export interface ChatCliOptions {
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly workspace: string;
}

export function parseChatArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ChatCliOptions {
  let provider: ChatCliOptions["provider"] | undefined;
  let model: string | undefined;
  let workspace = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--provider" && value !== undefined) {
      if (value !== "openai" && value !== "deepseek") {
        throw new Error("--provider must be openai or deepseek");
      }
      provider = value;
      index += 1;
    } else if (argument === "--model" && value !== undefined) {
      model = value;
      index += 1;
    } else if (argument === "--workspace" && value !== undefined) {
      workspace = resolve(cwd, value);
      index += 1;
    } else {
      throw new Error(`Unknown chat argument: ${argument ?? ""}`);
    }
  }
  if (provider === undefined) throw new Error("chat requires --provider openai|deepseek");
  model ??= environment[provider === "openai" ? "OPENAI_MODEL" : "DEEPSEEK_MODEL"]?.trim();
  if (model === undefined || model.length === 0) {
    throw new Error("chat requires --model or the provider model environment variable");
  }
  return { provider, model, workspace };
}

export async function runChatCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseChatArgs(args, environment);
  const apiKeyName = options.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  const apiKey = environment[apiKeyName]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`${apiKeyName} is required; agent-code does not load .env.local automatically`);
  }

  const provider: Provider = options.provider === "openai"
    ? new OpenAIResponsesProvider({ apiKey, model: options.model })
    : new DeepSeekChatProvider({ apiKey, model: options.model });
  const input = new NodeInputController();
  const renderer = new TerminalRenderer({ output: process.stdout });
  const trust = await WorkspaceTrust.create({ workspaceRoot: options.workspace });
  const permissions = new PermissionEngine({
    trust,
    decide: createTerminalPermissionHandler(input, renderer),
  });
  const runtime = await CodingAgentRuntime.create({
    provider,
    workspaceRoot: trust.workspaceRoot,
    permissions,
    shell: {
      runner: createPlatformSandboxRunner({
        workspaceRoot: trust.workspaceRoot,
        allowNetwork: false,
        fallback: "closed",
      }),
    },
  });
  const sandbox = runtime.sandboxStatus;
  const session = new CliSession({
    input,
    renderer,
    permissions,
    status: {
      provider: options.provider,
      model: options.model,
      workspace: trust.workspaceRoot,
      trusted: trust.trusted,
      sandbox: `${sandbox.filesystem}, network ${sandbox.network}`,
    },
    runTurn: async (request) => await runtime.runTurn({
      transcript: request.transcript,
      signal: request.signal,
      emit: request.emit,
    }),
  });

  try {
    await session.run();
    return 0;
  } finally {
    await runtime.dispose();
    input.close();
  }
}
