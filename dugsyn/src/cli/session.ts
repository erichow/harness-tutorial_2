import { randomUUID } from "node:crypto";

import { createTranscript, type Transcript } from "../messages/transcript.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { TurnFinishReason } from "../runtime/events.js";
import type { PermissionAuditEntry } from "../security/permissions.js";
import type { ContextReport } from "../context/manager.js";
import type { InputController } from "./input.js";
import type { TerminalRenderer } from "./renderer.js";

export interface SessionTurnResult {
  readonly transcript: Transcript;
  readonly reason: TurnFinishReason;
}

export interface SessionTurnRequest {
  readonly transcript: Transcript;
  readonly signal: AbortSignal;
  readonly emit: (event: RuntimeEvent) => void | Promise<void>;
}

export type SessionTurnRunner = (request: SessionTurnRequest) => Promise<SessionTurnResult>;

export interface SessionUndoResult {
  readonly status: "undone" | "nothing_to_undo" | "conflict";
  readonly paths?: readonly string[] | undefined;
  readonly message?: string | undefined;
}

export type SessionUndoRunner = () => Promise<SessionUndoResult>;

export interface SessionPermissionState {
  readonly auditLog: readonly PermissionAuditEntry[];
  clearSessionGrants(): void;
}

export interface CliSessionStatus {
  readonly provider: string;
  readonly model: string;
  readonly workspace: string;
  readonly trusted: boolean;
  readonly sandbox: string;
  readonly sessionId?: string | undefined;
  readonly sessionName?: string | undefined;
}

export interface CliSessionPersistence {
  persistTranscript(transcript: Transcript): Promise<void>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}

export interface CliSessionOptions {
  readonly input: InputController;
  readonly renderer: TerminalRenderer;
  readonly runTurn: SessionTurnRunner;
  readonly undo?: SessionUndoRunner | undefined;
  readonly status: CliSessionStatus;
  readonly permissions?: SessionPermissionState | undefined;
  readonly initialTranscript?: Transcript | undefined;
  readonly persistence?: CliSessionPersistence | undefined;
  readonly inspectContext?: ((transcript: Transcript) => Promise<ContextReport>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
}

export class CliSession {
  readonly #input: InputController;
  readonly #renderer: TerminalRenderer;
  readonly #runTurn: SessionTurnRunner;
  readonly #undo: SessionUndoRunner | undefined;
  readonly #status: CliSessionStatus;
  readonly #permissions: SessionPermissionState | undefined;
  readonly #persistence: CliSessionPersistence | undefined;
  readonly #inspectContext: ((transcript: Transcript) => Promise<ContextReport>) | undefined;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #transcript: Transcript;
  #activeTurn: AbortController | undefined;
  #closed = false;

  constructor(options: CliSessionOptions) {
    this.#input = options.input;
    this.#renderer = options.renderer;
    this.#runTurn = options.runTurn;
    this.#undo = options.undo;
    this.#status = options.status;
    this.#permissions = options.permissions;
    this.#persistence = options.persistence;
    this.#inspectContext = options.inspectContext;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#transcript = options.initialTranscript ?? createTranscript();
  }

  get transcript(): Transcript {
    return this.#transcript;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async run(): Promise<void> {
    const detach = this.#input.onInterrupt(() => this.handleInterrupt());
    this.#renderer.notice("dugsyn interactive session. Type /help for commands.");
    try {
      while (!this.#closed) {
        const line = await this.#input.readLine("> ");
        if (line === null) break;
        await this.handleLine(line);
      }
    } finally {
      detach();
      this.close();
    }
  }

  async handleLine(line: string): Promise<void> {
    if (this.#closed) return;
    const value = line.trim();
    if (value.length === 0) return;
    if (value.startsWith("/")) {
      await this.#handleCommand(value);
      return;
    }
    if (this.#activeTurn !== undefined) {
      this.#renderer.notice("A turn is already running.");
      return;
    }

    const controller = new AbortController();
    this.#activeTurn = controller;
    this.#transcript = {
      ...this.#transcript,
      messages: [
        ...this.#transcript.messages,
        {
          id: this.#createId(),
          role: "user",
          content: [{ type: "text", text: value }],
          createdAt: this.#now().toISOString(),
        },
      ],
    };
    try {
      // Persist the user's intent before any provider or tool side effect begins.
      await this.#persistence?.persistTranscript(this.#transcript);
      const result = await this.#runTurn({
        transcript: this.#transcript,
        signal: controller.signal,
        emit: async (event) => {
          this.#renderer.render(event);
          await this.#persistence?.appendRuntimeEvent(event);
        },
      });
      this.#transcript = result.transcript;
      await this.#persistence?.persistTranscript(this.#transcript);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#renderer.notice(`Turn failed: ${message}`);
    } finally {
      this.#renderer.finish();
      if (this.#activeTurn === controller) this.#activeTurn = undefined;
    }
  }

  handleInterrupt(): "cancelled" | "exit" {
    if (this.#activeTurn !== undefined) {
      if (!this.#activeTurn.signal.aborted) {
        this.#activeTurn.abort(new Error("Cancelled by Ctrl-C"));
        this.#renderer.notice("Cancelling current turn…");
      }
      return "cancelled";
    }
    this.#renderer.notice("Exiting.");
    this.close();
    return "exit";
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeTurn?.abort(new Error("Session closed"));
    this.#input.close();
  }

  async #handleCommand(command: string): Promise<void> {
    switch (command) {
      case "/help":
        this.#renderer.notice("Commands: /help /status /context /permissions /undo /clear /exit");
        return;
      case "/context": {
        if (this.#inspectContext === undefined) {
          this.#renderer.notice("Context inspection is not available in this session.");
          return;
        }
        try {
          const report = await this.#inspectContext(this.#transcript);
          this.#renderer.notice(renderContextReport(report));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#renderer.notice(`Context inspection failed: ${message}`);
        }
        return;
      }
      case "/status":
        this.#renderer.notice([
          `Provider: ${this.#status.provider} (${this.#status.model})`,
          `Workspace: ${this.#status.workspace}`,
          `Trusted: ${this.#status.trusted ? "yes" : "no"}`,
          `Sandbox: ${this.#status.sandbox}`,
          ...(this.#status.sessionId === undefined
            ? []
            : [`Session: ${this.#status.sessionName ?? this.#status.sessionId} (${this.#status.sessionId})`]),
          `Messages: ${this.#transcript.messages.length}`,
        ].join("\n"));
        return;
      case "/permissions": {
        const audit = this.#permissions?.auditLog ?? [];
        const allowed = audit.filter((entry) => entry.decision === "allow").length;
        const denied = audit.length - allowed;
        this.#renderer.notice(`Permission decisions: ${audit.length} (${allowed} allowed, ${denied} denied).`);
        return;
      }
      case "/undo": {
        if (this.#activeTurn !== undefined) {
          this.#renderer.notice("Cannot undo while a turn is running.");
          return;
        }
        if (this.#undo === undefined) {
          this.#renderer.notice("Undo is not available in this session.");
          return;
        }
        const result = await this.#undo();
        if (result.status === "undone") {
          const paths = result.paths ?? [];
          this.#renderer.notice(
            `Undid Agent file changes${paths.length === 0 ? "" : `: ${paths.join(", ")}`}. Shell and other external side effects were not reverted.`,
          );
        } else {
          this.#renderer.notice(result.message ?? "Nothing was undone.");
        }
        return;
      }
      case "/clear":
        this.#transcript = createTranscript();
        await this.#persistence?.persistTranscript(this.#transcript);
        this.#permissions?.clearSessionGrants();
        this.#renderer.notice("Conversation and session permission grants cleared.");
        return;
      case "/exit":
        this.#renderer.notice("Exiting.");
        this.close();
        return;
      default:
        this.#renderer.notice(`Unknown command: ${command}. Type /help.`);
    }
  }
}

export function renderContextReport(report: ContextReport): string {
  const pct = report.maxTokens > 0 ? ((report.estimatedTokens / report.maxTokens) * 100).toFixed(1) : "0.0";
  return [
    `Context: ~${fmtTokens(report.estimatedTokens)}/${fmtTokens(report.compressAt)} (${pct}%) (${report.compressed ? "compressed" : "full history"})  hard=${fmtTokens(report.maxTokens)}`,
    ...report.components.map(
      (item) => `  ${item.component}: ~${fmtTokens(item.estimatedTokens)} (${item.detail})`,
    ),
    `Messages: ${report.includedMessages}/${report.originalMessages} included; ${report.omittedMessages} summarized`,
    `Instructions: ${report.instructionFiles.length === 0
      ? "none"
      : report.instructionFiles.map((item) => `${item.path} [${item.scope}]`).join(", ")}`,
  ].join("\n");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(".0", "")}K`;
  return String(n);
}
