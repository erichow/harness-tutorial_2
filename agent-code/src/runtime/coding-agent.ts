import type { Transcript } from "../messages/transcript.js";
import type { Provider } from "../providers/provider.js";
import type { PermissionEngine } from "../security/permissions.js";
import { createWorkspaceFileToolset } from "../tools/files/index.js";
import type { UndoResult } from "../tools/files/checkpoint.js";
import { createGitTools } from "../tools/git/index.js";
import { ToolRegistry } from "../tools/registry.js";
import { createShellTools } from "../tools/shell/index.js";
import type { ProcessManagerOptions } from "../tools/shell/process-manager.js";
import { createTestTools } from "../tools/testing/index.js";
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
  readonly #undo: () => Promise<UndoResult>;
  readonly #beginCheckpoint: () => string;
  readonly #attachCheckpoint: (checkpointId: string, turnId: string) => void;
  readonly #finishCheckpoint: (checkpointId: string) => void;
  readonly #disposeProcesses: () => Promise<void>;
  #disposed = false;

  private constructor(options: {
    readonly provider: Provider;
    readonly registry: ToolRegistry;
    readonly sandboxStatus: SandboxStatus;
    readonly disposeProcesses: () => Promise<void>;
    readonly undo: () => Promise<UndoResult>;
    readonly beginCheckpoint: () => string;
    readonly attachCheckpoint: (checkpointId: string, turnId: string) => void;
    readonly finishCheckpoint: (checkpointId: string) => void;
  }) {
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.sandboxStatus = options.sandboxStatus;
    this.#disposeProcesses = options.disposeProcesses;
    this.#undo = options.undo;
    this.#beginCheckpoint = options.beginCheckpoint;
    this.#attachCheckpoint = options.attachCheckpoint;
    this.#finishCheckpoint = options.finishCheckpoint;
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
    const testTools = createTestTools(shell.processManager);
    return new CodingAgentRuntime({
      provider: options.provider,
      registry: new ToolRegistry([...fileToolset.tools, ...gitTools, ...shell.tools, ...testTools], {
        permissions: options.permissions,
      }),
      sandboxStatus: shell.processManager.sandboxStatus,
      disposeProcesses: async () => await shell.processManager.dispose(),
      undo: async () => await fileToolset.checkpoints.undoLatest(),
      beginCheckpoint: () => fileToolset.checkpoints.beginTurn(),
      attachCheckpoint: (checkpointId, turnId) =>
        fileToolset.checkpoints.attachTurn(checkpointId, turnId),
      finishCheckpoint: (checkpointId) => fileToolset.checkpoints.finishTurn(checkpointId),
    });
  }

  async runTurn(options: CodingAgentTurnOptions): Promise<RunTurnResult> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    const checkpointId = this.#beginCheckpoint();
    try {
      return await runTurn({
        provider: this.#provider,
        transcript: options.transcript,
        tools: this.#registry.createExecutor(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        emit: async (event) => {
          this.#attachCheckpoint(checkpointId, event.turnId);
          this.eventLog.append(event);
          await options.emit?.(event);
        },
      });
    } finally {
      this.#finishCheckpoint(checkpointId);
    }
  }

  /** Undo only the latest turn's file-tool writes after conflict preflight. */
  async undoLastTurn(): Promise<UndoResult> {
    if (this.#disposed) throw new Error("CodingAgentRuntime is disposed");
    return await this.#undo();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#disposeProcesses();
  }
}
