import type { Transcript } from "../messages/transcript.js";
import type { Provider } from "../providers/provider.js";
import type { PermissionEngine } from "../security/permissions.js";
import { createWorkspaceFileTools } from "../tools/files/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { createShellTools } from "../tools/shell/index.js";
import type { ProcessManagerOptions } from "../tools/shell/process-manager.js";
import type { SandboxStatus } from "../tools/shell/sandbox-runner.js";
import { runTurn, type RunTurnResult } from "./agent.js";
import { RuntimeEventLog } from "./event-log.js";
import type { RuntimeEvent } from "./events.js";
import type { TurnLimits } from "./limits.js";

export interface CodingAgentRuntimeOptions {
  readonly provider: Provider;
  readonly workspaceRoot: string;
  readonly permissions?: PermissionEngine | undefined;
  readonly shell?: Omit<ProcessManagerOptions, "workspaceRoot"> | undefined;
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
  readonly sandboxStatus: SandboxStatus;
  readonly #provider: Provider;
  readonly #registry: ToolRegistry;
  readonly #disposeProcesses: () => Promise<void>;
  #disposed = false;

  private constructor(options: {
    readonly provider: Provider;
    readonly registry: ToolRegistry;
    readonly sandboxStatus: SandboxStatus;
    readonly disposeProcesses: () => Promise<void>;
  }) {
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.sandboxStatus = options.sandboxStatus;
    this.#disposeProcesses = options.disposeProcesses;
  }

  static async create(options: CodingAgentRuntimeOptions): Promise<CodingAgentRuntime> {
    const fileTools = await createWorkspaceFileTools({ workspaceRoot: options.workspaceRoot });
    const shell = await createShellTools({
      ...options.shell,
      workspaceRoot: options.workspaceRoot,
    });
    return new CodingAgentRuntime({
      provider: options.provider,
      registry: new ToolRegistry([...fileTools, ...shell.tools], {
        permissions: options.permissions,
      }),
      sandboxStatus: shell.processManager.sandboxStatus,
      disposeProcesses: async () => await shell.processManager.dispose(),
    });
  }

  async runTurn(options: CodingAgentTurnOptions): Promise<RunTurnResult> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    return await runTurn({
      provider: this.#provider,
      transcript: options.transcript,
      tools: this.#registry.createExecutor(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      emit: async (event) => {
        this.eventLog.append(event);
        await options.emit?.(event);
      },
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#disposeProcesses();
  }
}
