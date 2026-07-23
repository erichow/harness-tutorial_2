import { resolve } from "node:path";

import { createPlatformSandboxRunner } from "../tools/shell/sandbox-runner.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses.js";
import { DeepSeekChatProvider } from "../providers/deepseek-chat.js";
import type { Provider } from "../providers/provider.js";
import { CodingAgentRuntime } from "../runtime/coding-agent.js";
import { PermissionEngine } from "../security/permissions.js";
import { WorkspaceTrust } from "../security/trust.js";
import { defaultSessionRoot, SessionStore, type SessionHandle } from "../sessions/store.js";
import { NodeInputController } from "./input.js";
import { createTerminalPermissionHandler } from "./permission-prompt.js";
import { TerminalRenderer } from "./renderer.js";
import { CliSession } from "./session.js";

export interface ChatCliOptions {
  readonly provider?: "openai" | "deepseek" | undefined;
  readonly model?: string | undefined;
  readonly workspace?: string | undefined;
  readonly sessionDirectory: string;
  readonly sessionName?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly forkSessionId?: string | undefined;
}

export function parseChatArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ChatCliOptions {
  let provider: ChatCliOptions["provider"] | undefined;
  let model: string | undefined;
  let workspace: string | undefined;
  let sessionDirectory = defaultSessionRoot(environment);
  let sessionName: string | undefined;
  let resumeSessionId: string | undefined;
  let forkSessionId: string | undefined;
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
    } else if (argument === "--session-dir" && value !== undefined) {
      sessionDirectory = resolve(cwd, value);
      index += 1;
    } else if (argument === "--session-name" && value !== undefined) {
      sessionName = value.trim();
      if (sessionName.length === 0) throw new Error("--session-name cannot be empty");
      index += 1;
    } else if (argument === "--resume" && value !== undefined) {
      resumeSessionId = value;
      index += 1;
    } else if (argument === "--fork-session" && value !== undefined) {
      forkSessionId = value;
      index += 1;
    } else {
      throw new Error(`Unknown chat argument: ${argument ?? ""}`);
    }
  }
  if (resumeSessionId !== undefined && forkSessionId !== undefined) {
    throw new Error("--resume and --fork-session cannot be used together");
  }
  if (resumeSessionId !== undefined && sessionName !== undefined) {
    throw new Error("--session-name can only be used for a new or forked session");
  }
  if (resumeSessionId === undefined && forkSessionId === undefined) {
    if (provider === undefined) throw new Error("chat requires --provider openai|deepseek");
    model ??= environment[provider === "openai" ? "OPENAI_MODEL" : "DEEPSEEK_MODEL"]?.trim();
    if (model === undefined || model.length === 0) {
      throw new Error("chat requires --model or the provider model environment variable");
    }
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(workspace === undefined ? {} : { workspace }),
    sessionDirectory,
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(forkSessionId === undefined ? {} : { forkSessionId }),
  };
}

export async function runChatCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseChatArgs(args, environment);
  if (
    options.resumeSessionId === undefined &&
    options.forkSessionId === undefined &&
    options.provider !== undefined
  ) {
    requireApiKey(options.provider, environment);
  }
  const store = new SessionStore({ rootDirectory: options.sessionDirectory });
  const context = await resolveSessionContext(store, options, environment);
  try {
    const apiKey = requireApiKey(context.provider, environment);

    const provider: Provider = context.provider === "openai"
      ? new OpenAIResponsesProvider({ apiKey, model: context.model })
      : new DeepSeekChatProvider({ apiKey, model: context.model });
    const trust = await WorkspaceTrust.create({ workspaceRoot: context.workspace });
    const input = new NodeInputController();
    let runtime: CodingAgentRuntime | undefined;

    try {
      const renderer = new TerminalRenderer({ output: process.stdout });
      const permissions = new PermissionEngine({
        trust,
        decide: createTerminalPermissionHandler(input, renderer),
      });
      runtime = await CodingAgentRuntime.create({
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
      const activeRuntime = runtime;
      const sandbox = activeRuntime.sandboxStatus;
      const session = new CliSession({
        input,
        renderer,
        permissions,
        status: {
          provider: context.provider,
          model: context.model,
          workspace: trust.workspaceRoot,
          trusted: trust.trusted,
          sandbox: `${sandbox.filesystem}, network ${sandbox.network}`,
          sessionId: context.handle.metadata.sessionId,
          sessionName: context.handle.metadata.name,
        },
        initialTranscript: context.handle.transcript,
        persistence: context.handle,
        runTurn: async (request) => await activeRuntime.runTurn({
          transcript: request.transcript,
          signal: request.signal,
          emit: request.emit,
        }),
        undo: async () => await activeRuntime.undoLastTurn(),
      });
      renderer.notice(
        `${context.mode === "resumed" ? "Resumed" : context.mode === "forked" ? "Forked" : "Created"} session ${context.handle.metadata.sessionId}.`,
      );
      await session.run();
      return 0;
    } finally {
      await runtime?.dispose();
      input.close();
    }
  } finally {
    await context.handle.close();
  }
}

function requireApiKey(
  provider: "openai" | "deepseek",
  environment: NodeJS.ProcessEnv,
): string {
  const name = provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  const apiKey = environment[name]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`${name} is required; agent-code does not load .env.local automatically`);
  }
  return apiKey;
}

interface ResolvedSessionContext {
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly workspace: string;
  readonly handle: SessionHandle;
  readonly mode: "created" | "resumed" | "forked";
}

async function resolveSessionContext(
  store: SessionStore,
  options: ChatCliOptions,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedSessionContext> {
  if (options.resumeSessionId !== undefined) {
    const snapshot = await store.read(options.resumeSessionId);
    assertResumeMatch("provider", options.provider, snapshot.metadata.provider);
    assertResumeMatch("model", options.model, snapshot.metadata.model);
    if (
      options.workspace !== undefined &&
      resolve(options.workspace) !== resolve(snapshot.metadata.projectPath)
    ) {
      throw new Error(
        `--workspace does not match resumed session project ${snapshot.metadata.projectPath}; use --fork-session to change it`,
      );
    }
    requireApiKey(snapshot.metadata.provider, environment);
    return {
      provider: snapshot.metadata.provider,
      model: snapshot.metadata.model,
      workspace: snapshot.metadata.projectPath,
      handle: await store.open(snapshot.metadata.sessionId),
      mode: "resumed",
    };
  }

  if (options.forkSessionId !== undefined) {
    const source = await store.read(options.forkSessionId);
    const provider = options.provider ?? source.metadata.provider;
    const changedProvider = provider !== source.metadata.provider;
    const environmentModel = changedProvider
      ? environment[provider === "openai" ? "OPENAI_MODEL" : "DEEPSEEK_MODEL"]?.trim()
      : undefined;
    const model = options.model ?? environmentModel ?? source.metadata.model;
    if (changedProvider && options.model === undefined && !environmentModel) {
      throw new Error(
        `Changing a fork from ${source.metadata.provider} to ${provider} requires --model or the provider model environment variable`,
      );
    }
    const workspace = options.workspace ?? source.metadata.projectPath;
    requireApiKey(provider, environment);
    return {
      provider,
      model,
      workspace,
      handle: await store.fork(source.metadata.sessionId, {
        ...(options.sessionName === undefined ? {} : { name: options.sessionName }),
        projectPath: workspace,
        provider,
        model,
      }),
      mode: "forked",
    };
  }

  if (options.provider === undefined || options.model === undefined) {
    throw new Error("New sessions require a provider and model.");
  }
  const workspace = options.workspace ?? process.cwd();
  return {
    provider: options.provider,
    model: options.model,
    workspace,
    handle: await store.create({
      ...(options.sessionName === undefined ? {} : { name: options.sessionName }),
      projectPath: workspace,
      provider: options.provider,
      model: options.model,
    }),
    mode: "created",
  };
}

function assertResumeMatch(
  field: string,
  explicit: string | undefined,
  stored: string,
): void {
  if (explicit !== undefined && explicit !== stored) {
    throw new Error(
      `--${field} ${explicit} does not match resumed session ${field} ${stored}; use --fork-session to change it`,
    );
  }
}
