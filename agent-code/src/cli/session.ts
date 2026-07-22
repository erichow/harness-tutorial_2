import { randomUUID } from "node:crypto";

import { createTranscript, type Transcript } from "../messages/transcript.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { TurnFinishReason } from "../runtime/events.js";
import type { PermissionAuditEntry } from "../security/permissions.js";
import type { InputController } from "./input.js";
import type { TerminalRenderer } from "./renderer.js";

export interface SessionTurnResult {
  readonly transcript: Transcript;
  readonly reason: TurnFinishReason;
}

export interface SessionTurnRequest {
  readonly transcript: Transcript;
  readonly signal: AbortSignal;
  readonly emit: (event: RuntimeEvent) => void;
}

export type SessionTurnRunner = (request: SessionTurnRequest) => Promise<SessionTurnResult>;

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
}

export interface CliSessionOptions {
  readonly input: InputController;
  readonly renderer: TerminalRenderer;
  readonly runTurn: SessionTurnRunner;
  readonly status: CliSessionStatus;
  readonly permissions?: SessionPermissionState | undefined;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
}

export class CliSession {
  readonly #input: InputController;
  readonly #renderer: TerminalRenderer;
  readonly #runTurn: SessionTurnRunner;
  readonly #status: CliSessionStatus;
  readonly #permissions: SessionPermissionState | undefined;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #transcript = createTranscript();
  #activeTurn: AbortController | undefined;
  #closed = false;

  constructor(options: CliSessionOptions) {
    this.#input = options.input;
    this.#renderer = options.renderer;
    this.#runTurn = options.runTurn;
    this.#status = options.status;
    this.#permissions = options.permissions;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  get transcript(): Transcript {
    return this.#transcript;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async run(): Promise<void> {
    const detach = this.#input.onInterrupt(() => this.handleInterrupt());
    this.#renderer.notice("agent-code interactive session. Type /help for commands.");
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
      this.#handleCommand(value);
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
      const result = await this.#runTurn({
        transcript: this.#transcript,
        signal: controller.signal,
        emit: (event) => this.#renderer.render(event),
      });
      this.#transcript = result.transcript;
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

  #handleCommand(command: string): void {
    switch (command) {
      case "/help":
        this.#renderer.notice("Commands: /help /status /permissions /clear /exit");
        return;
      case "/status":
        this.#renderer.notice([
          `Provider: ${this.#status.provider} (${this.#status.model})`,
          `Workspace: ${this.#status.workspace}`,
          `Trusted: ${this.#status.trusted ? "yes" : "no"}`,
          `Sandbox: ${this.#status.sandbox}`,
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
      case "/clear":
        this.#transcript = createTranscript();
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
