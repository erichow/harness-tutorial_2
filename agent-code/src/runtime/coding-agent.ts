import type { Transcript } from "../messages/transcript.js";
import {
  ContextManager,
  type ContextManagerOptions,
  type ContextReport,
} from "../context/manager.js";
import { InstructionLoader, type InstructionLoaderOptions } from "../context/instructions.js";
import type { Provider } from "../providers/provider.js";
import type { PermissionEngine } from "../security/permissions.js";
import type { WorkspaceTrust } from "../security/trust.js";
import {
  HookRunner,
  type HookCommandExecutor,
  type HookConfiguration,
} from "../extensions/hooks.js";
import {
  createMcpToolset,
  type McpServerConfiguration,
  type McpTransportFactory,
} from "../extensions/mcp.js";
import {
  createLspToolset,
  type LspClientFactory,
  type LspServerConfiguration,
} from "../extensions/lsp.js";
import { createSkillLoaderTool, SkillCatalog } from "../extensions/skills.js";
import { createWorkspaceFileToolset } from "../tools/files/index.js";
import type { UndoResult } from "../tools/files/checkpoint.js";
import { createGitTools } from "../tools/git/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { createShellTools } from "../tools/shell/index.js";
import type { ProcessManagerOptions } from "../tools/shell/process-manager.js";
import { createTestTools } from "../tools/testing/index.js";
import type { Tool } from "../tools/tool.js";
import type { SandboxStatus } from "../tools/shell/sandbox-runner.js";
import { TraceRecorder, type TraceRecorderOptions } from "../observability/trace.js";
import { runTurn, type RunTurnResult } from "./agent.js";
import { RuntimeEventLog } from "./event-log.js";
import type { RuntimeEvent } from "./events.js";
import type { TurnLimits } from "./limits.js";

export interface CodingAgentRuntimeOptions {
  readonly provider: Provider;
  readonly workspaceRoot: string;
  readonly permissions?: PermissionEngine | undefined;
  readonly shell?: Omit<ProcessManagerOptions, "workspaceRoot"> | undefined;
  readonly context?: Omit<ContextManagerOptions, "instructions"> & {
    readonly instructions?: Omit<InstructionLoaderOptions, "workspaceRoot"> | undefined;
  } | undefined;
  readonly observability?: TraceRecorderOptions | undefined;
  readonly tools?: {
    /**
     * Expose only these tools to the Provider and executor. Unknown names fail
     * runtime construction so a misspelled capability cannot be silently widened.
     */
    readonly allowedNames?: readonly string[] | undefined;
  } | undefined;
  readonly extensions?: {
    readonly trust: WorkspaceTrust;
    readonly mcpServers?: Readonly<Record<string, McpServerConfiguration>> | undefined;
    readonly lspServers?: Readonly<Record<string, LspServerConfiguration>> | undefined;
    readonly hooks?: HookConfiguration | undefined;
    readonly skills?: {
      readonly userDirectory?: string | undefined;
      readonly maxFileBytes?: number | undefined;
    } | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
    readonly diagnostic?: ((message: string) => void) | undefined;
    /** Test seams; normal callers should leave these unset. */
    readonly createMcpTransport?: McpTransportFactory | undefined;
    readonly createLspClient?: LspClientFactory | undefined;
    readonly executeHook?: HookCommandExecutor | undefined;
  } | undefined;
}

export interface CodingAgentTurnOptions {
  readonly transcript: Transcript;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: TurnLimits | undefined;
  readonly emit?: ((event: RuntimeEvent) => void | Promise<void>) | undefined;
}

/** Owns the complete MVP runtime, including its event log and child processes. */
export class CodingAgentRuntime {
  readonly eventLog = new RuntimeEventLog();
  readonly trace: TraceRecorder;
  readonly sandboxStatus: SandboxStatus;
  readonly #provider: Provider;
  readonly #context: ContextManager;
  readonly #registry: ToolRegistry;
  readonly #undo: () => Promise<UndoResult>;
  readonly #beginCheckpoint: () => string;
  readonly #attachCheckpoint: (checkpointId: string, turnId: string) => void;
  readonly #finishCheckpoint: (checkpointId: string) => void;
  readonly #disposeProcesses: () => Promise<void>;
  readonly #disposeMcp: () => Promise<void>;
  readonly #disposeLsp: () => Promise<void>;
  readonly #hooks: HookRunner | undefined;
  #disposed = false;

  private constructor(options: {
    readonly provider: Provider;
    readonly context: ContextManager;
    readonly registry: ToolRegistry;
    readonly sandboxStatus: SandboxStatus;
    readonly disposeProcesses: () => Promise<void>;
    readonly disposeMcp: () => Promise<void>;
    readonly disposeLsp: () => Promise<void>;
    readonly hooks?: HookRunner | undefined;
    readonly undo: () => Promise<UndoResult>;
    readonly beginCheckpoint: () => string;
    readonly attachCheckpoint: (checkpointId: string, turnId: string) => void;
    readonly finishCheckpoint: (checkpointId: string) => void;
    readonly trace: TraceRecorder;
  }) {
    this.#provider = options.provider;
    this.#context = options.context;
    this.#registry = options.registry;
    this.sandboxStatus = options.sandboxStatus;
    this.#disposeProcesses = options.disposeProcesses;
    this.#disposeMcp = options.disposeMcp;
    this.#disposeLsp = options.disposeLsp;
    this.#hooks = options.hooks;
    this.#undo = options.undo;
    this.#beginCheckpoint = options.beginCheckpoint;
    this.#attachCheckpoint = options.attachCheckpoint;
    this.#finishCheckpoint = options.finishCheckpoint;
    this.trace = options.trace;
  }

  static async create(options: CodingAgentRuntimeOptions): Promise<CodingAgentRuntime> {
    const fileToolset = await createWorkspaceFileToolset({ workspaceRoot: options.workspaceRoot });
    const gitTools = await createGitTools({
      workspaceRoot: options.workspaceRoot,
      checkpoints: fileToolset.checkpoints,
    });
    const shell = await createShellTools({
      ...options.shell,
      workspaceRoot: options.workspaceRoot,
    });
    let disposeMcp = async (): Promise<void> => undefined;
    let disposeLsp = async (): Promise<void> => undefined;
    let createdRuntime: CodingAgentRuntime | undefined;
    try {
      const testTools = createTestTools(shell.processManager);
      const hooks = options.extensions === undefined
        ? undefined
        : new HookRunner({
            workspaceRoot: options.workspaceRoot,
            hooks: options.extensions.hooks,
            environment: options.extensions.environment,
            execute: options.extensions.executeHook,
            diagnostic: options.extensions.diagnostic,
          });
      const mcp = await createMcpToolset({
        workspaceRoot: options.workspaceRoot,
        servers: options.extensions?.mcpServers,
        environment: options.extensions?.environment,
        createTransport: options.extensions?.createMcpTransport,
        diagnostic: options.extensions?.diagnostic,
      });
      disposeMcp = async () => await mcp.dispose();
      const lsp = await createLspToolset({
        workspaceRoot: options.workspaceRoot,
        servers: options.extensions?.lspServers,
        environment: options.extensions?.environment,
        createClient: options.extensions?.createLspClient,
        diagnostic: options.extensions?.diagnostic,
      });
      disposeLsp = async () => await lsp.dispose();
      const skills = options.extensions === undefined
        ? undefined
        : await SkillCatalog.create({
            workspaceRoot: options.workspaceRoot,
            trust: options.extensions.trust,
            userDirectory: options.extensions.skills?.userDirectory,
            maxFileBytes: options.extensions.skills?.maxFileBytes,
          });
      const instructions = await InstructionLoader.create({
        workspaceRoot: options.workspaceRoot,
        ...options.context?.instructions,
      });
      const context = new ContextManager({
        instructions,
        skills,
        ...(options.context?.maxTokens === undefined
          ? {}
          : { maxTokens: options.context.maxTokens }),
        ...(options.context?.systemPrompt === undefined
          ? {}
          : { systemPrompt: options.context.systemPrompt }),
        ...(options.context?.now === undefined ? {} : { now: options.context.now }),
      });
      const skillLoader = skills === undefined ? undefined : createSkillLoaderTool(skills);
      const allTools: readonly Tool[] = [
        ...fileToolset.tools,
        ...gitTools,
        ...shell.tools,
        ...testTools,
        ...mcp.tools,
        ...lsp.tools,
        ...(skillLoader === undefined ? [] : [skillLoader]),
      ];
      const tools = selectTools(allTools, options.tools?.allowedNames);
      const runtime = new CodingAgentRuntime({
        provider: options.provider,
        context,
        registry: new ToolRegistry(tools, {
          permissions: options.permissions,
          hooks,
        }),
        sandboxStatus: shell.processManager.sandboxStatus,
        disposeProcesses: async () => await shell.processManager.dispose(),
        disposeMcp: async () => await mcp.dispose(),
        disposeLsp: async () => await lsp.dispose(),
        hooks,
        undo: async () => await fileToolset.checkpoints.undoLatest(),
        beginCheckpoint: () => fileToolset.checkpoints.beginTurn(),
        attachCheckpoint: (checkpointId, turnId) =>
          fileToolset.checkpoints.attachTurn(checkpointId, turnId),
        finishCheckpoint: (checkpointId) => fileToolset.checkpoints.finishTurn(checkpointId),
        trace: new TraceRecorder(options.observability),
      });
      createdRuntime = runtime;
      await hooks?.notify("SessionStart", {
        workspaceRoot: options.workspaceRoot,
        mcpServers: [...mcp.connectedServers],
        lspServers: [...lsp.connectedServers],
        skills: skills?.entries.map(({ name, source, path }) => ({ name, source, path })) ?? [],
      }, AbortSignal.timeout(10_000));
      return runtime;
    } catch (error) {
      if (createdRuntime === undefined) {
        await Promise.all([shell.processManager.dispose(), disposeMcp(), disposeLsp()]);
      } else {
        await createdRuntime.dispose();
      }
      throw error;
    }
  }

  async runTurn(options: CodingAgentTurnOptions): Promise<RunTurnResult> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    const checkpointId = this.#beginCheckpoint();
    try {
      const result = await runTurn({
        provider: this.#provider,
        transcript: options.transcript,
        tools: this.#registry.createExecutor(),
        context: this.#context,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        emit: async (event) => {
          this.#attachCheckpoint(checkpointId, event.turnId);
          this.eventLog.append(event);
          this.trace.record(event);
          await options.emit?.(event);
        },
      });
      await this.#hooks?.notify("Stop", {
        turnId: result.turnId,
        reason: result.reason,
        steps: result.steps,
      }, AbortSignal.timeout(10_000));
      return result;
    } finally {
      this.#finishCheckpoint(checkpointId);
    }
  }

  /** Returns the exact estimated provider context for the current durable transcript. */
  async inspectContext(transcript: Transcript): Promise<ContextReport> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    return (await this.#context.prepare(transcript, this.#registry.definitions)).report;
  }

  /** Undo only the latest turn's file-tool writes after conflict preflight. */
  async undoLastTurn(): Promise<UndoResult> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    return await this.#undo();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await Promise.all([this.#disposeProcesses(), this.#disposeMcp(), this.#disposeLsp()]);
    } finally {
      this.trace.finish();
    }
  }
}

function selectTools(
  tools: readonly Tool[],
  allowedNames: readonly string[] | undefined,
): readonly Tool[] {
  if (allowedNames === undefined) return tools;
  const allowed = new Set(allowedNames);
  if (allowed.size !== allowedNames.length) {
    throw new TypeError("Tool allowlist contains duplicate names");
  }
  const available = new Set(tools.map((tool) => tool.definition.name));
  const unknown = [...allowed].filter((name) => !available.has(name)).sort();
  if (unknown.length > 0) {
    throw new TypeError(`Unknown allowed tool names: ${unknown.join(", ")}`);
  }
  return tools.filter((tool) => allowed.has(tool.definition.name));
}
