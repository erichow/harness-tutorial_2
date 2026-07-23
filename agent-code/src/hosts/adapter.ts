import type { RunTurnResult } from "../runtime/agent.js";
import type { RuntimeEvent } from "../runtime/events.js";
import {
  HOST_PROTOCOL_VERSION,
  hostCommandSchema,
  toPublicRuntimeEvent,
  type HostCommand,
  type HostEvent,
} from "./protocol.js";

export type HostTransportKind = "ide" | "websocket";

export interface HostTransport {
  readonly kind: HostTransportKind;
  readonly messages: AsyncIterable<unknown>;
  send(event: HostEvent): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface HostTurnRunner {
  runTurn(options: {
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly emit: (event: RuntimeEvent) => void | Promise<void>;
  }): Promise<Pick<RunTurnResult, "turnId" | "reason">>;
}

/**
 * Shared IDE/Web session adapter. It keeps transport concerns out of the Agent
 * loop, validates the version handshake, and allows cancellation to arrive
 * while a turn is still running.
 */
export class HostSessionAdapter {
  readonly #transport: HostTransport;
  readonly #runner: HostTurnRunner;
  #active:
    | {
        readonly requestId: string;
        readonly controller: AbortController;
        readonly promise: Promise<void>;
      }
    | undefined;
  #handshake = false;
  #closed = false;

  constructor(options: {
    readonly transport: HostTransport;
    readonly runner: HostTurnRunner;
  }) {
    this.#transport = options.transport;
    this.#runner = options.runner;
  }

  async serve(): Promise<void> {
    try {
      for await (const input of this.#transport.messages) {
        const parsed = hostCommandSchema.safeParse(input);
        if (!parsed.success) {
          await this.#send({
            protocolVersion: HOST_PROTOCOL_VERSION,
            type: "protocol_error",
            code: "invalid_message",
            message: parsed.error.issues[0]?.message ?? "Invalid host message",
          });
          continue;
        }
        await this.#handle(parsed.data);
      }
      await this.#active?.promise;
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#active?.controller.abort(new Error("Host transport closed"));
    await this.#active?.promise;
    await this.#transport.close();
  }

  async #handle(command: HostCommand): Promise<void> {
    if (command.type === "hello") {
      this.#handshake = true;
      await this.#send({
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "ready",
        server: "agent-code",
      });
      return;
    }
    if (!this.#handshake) {
      await this.#send({
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "protocol_error",
        requestId: command.requestId,
        code: "handshake_required",
        message: "Send a compatible hello message before turn commands.",
      });
      return;
    }
    if (command.type === "cancel_turn") {
      if (this.#active?.requestId !== command.requestId) {
        await this.#send({
          protocolVersion: HOST_PROTOCOL_VERSION,
          type: "protocol_error",
          requestId: command.requestId,
          code: "no_active_turn",
          message: "No matching turn is active.",
        });
        return;
      }
      this.#active.controller.abort(new Error("Cancelled by host"));
      return;
    }
    if (this.#active !== undefined) {
      await this.#send({
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "protocol_error",
        requestId: command.requestId,
        code: "turn_active",
        message: "Only one turn may run per host session.",
      });
      return;
    }

    const controller = new AbortController();
    const promise = this.#run(command, controller).finally(() => {
      if (this.#active?.requestId === command.requestId) this.#active = undefined;
    });
    this.#active = { requestId: command.requestId, controller, promise };
  }

  async #run(
    command: Extract<HostCommand, { type: "start_turn" }>,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await this.#runner.runTurn({
        prompt: command.prompt,
        signal: controller.signal,
        emit: async (event) => {
          await this.#send({
            protocolVersion: HOST_PROTOCOL_VERSION,
            type: "runtime_event",
            requestId: command.requestId,
            event: toPublicRuntimeEvent(event),
          });
        },
      });
      await this.#send({
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "turn_result",
        requestId: command.requestId,
        turnId: result.turnId,
        reason: result.reason,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await this.#send({
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "turn_result",
        requestId: command.requestId,
        turnId: "unavailable",
        reason: cancelled ? "cancelled" : "error",
      });
    }
  }

  async #send(event: HostEvent): Promise<void> {
    if (!this.#closed) await this.#transport.send(event);
  }
}

/** Named factories make the two supported host boundaries explicit. */
export function createIdeTransportAdapter(
  transport: Omit<HostTransport, "kind">,
): HostTransport {
  return { ...transport, kind: "ide" };
}

export function createWebSocketTransportAdapter(
  transport: Omit<HostTransport, "kind">,
): HostTransport {
  return { ...transport, kind: "websocket" };
}
