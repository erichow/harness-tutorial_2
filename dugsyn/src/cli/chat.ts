import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfiguration, type LoadedConfiguration } from "../config/loader.js";
import { createPlatformSandboxRunner } from "../tools/shell/sandbox-runner.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses.js";
import { DeepSeekChatProvider } from "../providers/deepseek-chat.js";
import type { Provider } from "../providers/provider.js";
import {
  CodingAgentRuntime,
  type CodingAgentRuntimeOptions,
} from "../runtime/coding-agent.js";
import { resolveModelContextTokens } from "../context/manager.js";
import { resolveTurnLimits } from "../runtime/limits.js";
import { PermissionEngine } from "../security/permissions.js";
import {
  assertHostAllowed,
  createManagedAuditExporter,
} from "../security/team-policy.js";
import { defaultSessionRoot, SessionStore, type SessionHandle } from "../sessions/store.js";
import { NodeInputController } from "./input.js";
import { createTerminalPermissionHandler } from "./permission-prompt.js";
import { TerminalRenderer } from "./renderer.js";
import { CliSession } from "./session.js";
import { CliUsageError } from "./errors.js";

export interface ChatCliOptions {
  readonly provider?: "openai" | "deepseek" | undefined;
  readonly model?: string | undefined;
  readonly workspace?: string | undefined;
  readonly sessionDirectory: string;
  readonly sessionName?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly forkSessionId?: string | undefined;
  readonly contextTokens?: number | undefined;
  readonly compressAt?: number | undefined;
}

export interface ChatConfigurationDefaults {
  readonly provider?: "openai" | "deepseek" | undefined;
  readonly model?: string | undefined;
  readonly models?: Readonly<Partial<Record<"openai" | "deepseek", string | undefined>>> | undefined;
  readonly sessionDirectory?: string | undefined;
}

export function parseChatArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  defaults: ChatConfigurationDefaults = {},
): ChatCliOptions {
  let provider: ChatCliOptions["provider"] | undefined;
  let model: string | undefined;
  let workspace: string | undefined;
  let sessionDirectory = resolve(
    cwd,
    environment.DUGSYN_SESSION_DIR?.trim() ||
    defaults.sessionDirectory ||
    defaultSessionRoot({}),
  );
  let sessionName: string | undefined;
  let resumeSessionId: string | undefined;
  let forkSessionId: string | undefined;
  let contextTokens: number | undefined;
  let compressAt: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (
      [
        "--provider",
        "--model",
        "--workspace",
        "--session-dir",
        "--session-name",
        "--resume",
        "--fork-session",
        "--context-tokens",
        "--compress-at",
      ].includes(argument ?? "") &&
      (value === undefined || value.startsWith("--"))
    ) {
      throw new CliUsageError(`${argument ?? "Option"} requires a value`);
    }
    if (argument === "--provider" && value !== undefined) {
      if (value !== "openai" && value !== "deepseek") {
        throw new CliUsageError("--provider must be openai or deepseek");
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
      if (sessionName.length === 0) throw new CliUsageError("--session-name cannot be empty");
      index += 1;
    } else if (argument === "--resume" && value !== undefined) {
      resumeSessionId = value;
      index += 1;
    } else if (argument === "--fork-session" && value !== undefined) {
      forkSessionId = value;
      index += 1;
    } else if (argument === "--context-tokens" && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError("--context-tokens must be a positive integer");
      }
      contextTokens = parsed;
      index += 1;
    } else if (argument === "--compress-at" && value !== undefined) {
      const cparsed = Number.parseInt(value, 10);
      if (!Number.isInteger(cparsed) || cparsed < 1) {
        throw new CliUsageError("--compress-at must be a positive integer");
      }
      compressAt = cparsed;
      index += 1;
    } else {
      throw new CliUsageError(`Unknown chat argument: ${argument ?? ""}`);
    }
  }
  if (resumeSessionId !== undefined && forkSessionId !== undefined) {
    throw new CliUsageError("--resume and --fork-session cannot be used together");
  }
  if (resumeSessionId !== undefined && sessionName !== undefined) {
    throw new CliUsageError("--session-name can only be used for a new or forked session");
  }
  if (resumeSessionId === undefined) {
    const environmentProvider = environment.DUGSYN_PROVIDER?.trim();
    if (
      environmentProvider !== undefined &&
      environmentProvider.length > 0 &&
      environmentProvider !== "openai" &&
      environmentProvider !== "deepseek"
    ) {
      throw new CliUsageError("DUGSYN_PROVIDER must be openai or deepseek");
    }
    provider ??= environmentProvider === "openai" || environmentProvider === "deepseek"
      ? environmentProvider
      : defaults.provider;
    const environmentModel = environment.DUGSYN_MODEL?.trim();
    if (provider !== undefined) {
      model ??= environmentModel || defaults.model || defaults.models?.[provider];
    }
  }
  if (resumeSessionId === undefined && forkSessionId === undefined) {
    if (provider === undefined) {
      throw new CliUsageError("chat requires --provider openai|deepseek");
    }
    if (model === undefined || model.length === 0) {
      throw new CliUsageError(
        "chat requires --model, DUGSYN_MODEL, or a configured model for the provider",
      );
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
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(compressAt === undefined ? {} : { compressAt }),
  };
}

export async function runChatCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const initialWorkspace = explicitWorkspace(args, process.cwd()) ?? process.cwd();
  const initialConfiguration = await loadConfiguration({
    workspaceRoot: initialWorkspace,
    environment,
  });
  const options = parseChatArgs(
    args,
    environment,
    process.cwd(),
    chatDefaults(initialConfiguration),
  );
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

    const configuration = resolve(context.workspace) === initialConfiguration.trust.workspaceRoot
      ? initialConfiguration
      : await loadConfiguration({ workspaceRoot: context.workspace, environment });
    assertHostAllowed(configuration, "cli");

    const provider: Provider = context.provider === "openai"
      ? new OpenAIResponsesProvider({ apiKey, model: context.model })
      : new DeepSeekChatProvider({ apiKey, model: context.model });
    const trust = configuration.trust;
    const input = new NodeInputController();
    let runtime: CodingAgentRuntime | undefined;

    try {
      const renderer = new TerminalRenderer({ output: process.stdout });
      const permissions = new PermissionEngine({
        trust,
        managedRules: configuration.permissions.managedRules,
        userRules: configuration.permissions.userRules,
        projectRules: configuration.permissions.projectRules,
        defaultDecision: configuration.permissions.defaultDecision ?? "allow",
        decide: createTerminalPermissionHandler(input, renderer),
      });
      runtime = await CodingAgentRuntime.create({
        provider,
        workspaceRoot: trust.workspaceRoot,
        permissions,
        enforceStatBeforeRead: true,
        shell: {
          runner: createPlatformSandboxRunner({
            workspaceRoot: trust.workspaceRoot,
            allowNetwork: false,
            fallback: "closed",
          }),
        },
        context: runtimeContext(
          configuration,
          context.provider,
          context.model,
          options.contextTokens,
          options.compressAt,
          `${options.sessionDirectory}/${context.handle.metadata.sessionId}/provider-transcript.jsonl`,
        ),
        observability: {
          sessionId: context.handle.metadata.sessionId,
          auditExporter: createManagedAuditExporter({
            configuration,
            environment,
            sessionId: context.handle.metadata.sessionId,
            diagnostic: (message) => renderer.notice(message),
          }),
        },
        extensions: runtimeExtensions(
          configuration,
          environment,
          (message) => renderer.notice(message),
        ),
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
        inspectContext: async (transcript) => await activeRuntime.inspectContext(transcript),
        runTurn: async (request) => await activeRuntime.runTurn({
          transcript: request.transcript,
          signal: request.signal,
          emit: request.emit,
          limits: resolveTurnLimits(configuration.turn),
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

export function requireApiKey(
  provider: "openai" | "deepseek",
  environment: NodeJS.ProcessEnv,
): string {
  const name = provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  const apiKey = environment[name]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new CliUsageError(
      `${name} is required; dugsyn does not load .env.local automatically`,
    );
  }
  return apiKey;
}

export interface ResolvedSessionContext {
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly workspace: string;
  readonly handle: SessionHandle;
  readonly mode: "created" | "resumed" | "forked";
}

export async function resolveSessionContext(
  store: SessionStore,
  options: ChatCliOptions,
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<ResolvedSessionContext> {
  if (options.resumeSessionId !== undefined) {
    const snapshot = await store.read(options.resumeSessionId);
    assertResumeMatch("provider", options.provider, snapshot.metadata.provider);
    assertResumeMatch("model", options.model, snapshot.metadata.model);
    const storedWorkspace = await canonicalWorkspace(snapshot.metadata.projectPath);
    if (
      options.workspace !== undefined &&
      await canonicalWorkspace(options.workspace) !== storedWorkspace
    ) {
      throw new CliUsageError(
        `--workspace does not match resumed session project ${snapshot.metadata.projectPath}; use --fork-session to change it`,
      );
    }
    requireApiKey(snapshot.metadata.provider, environment);
    return {
      provider: snapshot.metadata.provider,
      model: snapshot.metadata.model,
      workspace: storedWorkspace,
      handle: await store.open(snapshot.metadata.sessionId),
      mode: "resumed",
    };
  }

  if (options.forkSessionId !== undefined) {
    const source = await store.read(options.forkSessionId);
    const provider = options.provider ?? source.metadata.provider;
    const changedProvider = provider !== source.metadata.provider;
    const environmentModel = changedProvider
      ? environment.DUGSYN_MODEL?.trim()
      : undefined;
    const model = options.model ?? environmentModel ?? source.metadata.model;
    if (changedProvider && options.model === undefined && !environmentModel) {
      throw new CliUsageError(
        `Changing a fork from ${source.metadata.provider} to ${provider} requires --model, DUGSYN_MODEL, or a configured model`,
      );
    }
    const workspace = await canonicalWorkspace(
      options.workspace ?? source.metadata.projectPath,
    );
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
    throw new CliUsageError("New sessions require a provider and model.");
  }
  const workspace = await canonicalWorkspace(options.workspace ?? cwd);
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

export function chatDefaults(configuration: LoadedConfiguration): ChatConfigurationDefaults {
  return {
    ...(configuration.provider === undefined ? {} : { provider: configuration.provider }),
    ...(configuration.model === undefined ? {} : { model: configuration.model }),
    models: configuration.models,
    ...(configuration.sessionDirectory === undefined
      ? {}
      : { sessionDirectory: configuration.sessionDirectory }),
  };
}

function resolveContextMaxTokens(
  configMaxTokens: number | undefined,
  provider: string | undefined,
  model: string | undefined,
  cliContextTokens: number | undefined,
): number | undefined {
  if (cliContextTokens !== undefined) return cliContextTokens;
  if (configMaxTokens !== undefined) return configMaxTokens;
  if (provider !== undefined && model !== undefined) {
    return resolveModelContextTokens(provider, model);
  }
  return undefined;
}

export function runtimeContext(
  configuration: LoadedConfiguration,
  provider?: string,
  model?: string,
  cliContextTokens?: number,
  cliCompressAt?: number,
  providerTranscriptPath?: string,
): {
  maxTokens?: number;
  compressAt?: number;
  providerTranscriptPath?: string;
  instructions: {
    userInstructionPath?: string;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  };
} {
  return {
    ...(resolveContextMaxTokens(configuration.context.maxTokens, provider, model, cliContextTokens) === undefined
      ? {}
      : { maxTokens: resolveContextMaxTokens(configuration.context.maxTokens, provider, model, cliContextTokens)! }),
    ...(cliCompressAt ?? configuration.context.compressAt === undefined
      ? {}
      : { compressAt: cliCompressAt ?? configuration.context.compressAt }),
    ...(providerTranscriptPath === undefined ? {} : { providerTranscriptPath }),
    instructions: {
      ...(configuration.instructions.userPath === undefined
        ? {}
        : { userInstructionPath: configuration.instructions.userPath }),
      ...(configuration.instructions.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: configuration.instructions.maxFileBytes }),
      ...(configuration.instructions.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: configuration.instructions.maxTotalBytes }),
    },
  };
}

export function runtimeExtensions(
  configuration: LoadedConfiguration,
  environment: NodeJS.ProcessEnv,
  diagnostic?: (message: string) => void,
): NonNullable<CodingAgentRuntimeOptions["extensions"]> {
  return {
    trust: configuration.trust,
    mcpServers: configuration.mcpServers,
    lspServers: configuration.lspServers,
    hooks: configuration.hooks,
    skills: configuration.skills,
    environment,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

export function explicitWorkspace(args: readonly string[], cwd: string): string | undefined {
  let workspace: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--workspace" && args[index + 1] !== undefined) {
      workspace = resolve(cwd, args[index + 1] as string);
      index += 1;
    }
  }
  return workspace;
}

function assertResumeMatch(
  field: string,
  explicit: string | undefined,
  stored: string,
): void {
  if (explicit !== undefined && explicit !== stored) {
    throw new CliUsageError(
      `--${field} ${explicit} does not match resumed session ${field} ${stored}; use --fork-session to change it`,
    );
  }
}

async function canonicalWorkspace(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Workspace is not accessible: ${resolve(path)} (${message})`, {
      cause: error,
    });
  }
}
