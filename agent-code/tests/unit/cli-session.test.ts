import { describe, expect, it } from "vitest";

import type { InputController } from "../../src/cli/input.js";
import { TerminalRenderer } from "../../src/cli/renderer.js";
import { CliSession, type SessionTurnRunner } from "../../src/cli/session.js";

class FakeInput implements InputController {
  closed = false;
  interrupt: (() => void) | undefined;

  async readLine(): Promise<string | null> { return null; }
  onInterrupt(handler: () => void): () => void {
    this.interrupt = handler;
    return () => { this.interrupt = undefined; };
  }
  close(): void { this.closed = true; }
}

function fixture(runTurn: SessionTurnRunner) {
  const chunks: string[] = [];
  const input = new FakeInput();
  const renderer = new TerminalRenderer({
    output: { write: (chunk) => chunks.push(chunk), columns: 200 },
  });
  const permissionState = {
    auditLog: [],
    clears: 0,
    clearSessionGrants() { this.clears += 1; },
  };
  const session = new CliSession({
    input,
    renderer,
    runTurn,
    permissions: permissionState,
    status: {
      provider: "mock",
      model: "fixture",
      workspace: "/workspace",
      trusted: false,
      sandbox: "blocked",
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    createId: () => "message-1",
  });
  return { session, input, permissionState, text: () => chunks.join("") };
}

describe("CliSession", () => {
  it("supports the chapter slash commands without invoking the model", async () => {
    let turns = 0;
    const item = fixture(async ({ transcript }) => {
      turns += 1;
      return { transcript, reason: "completed" };
    });

    await item.session.handleLine("/help");
    await item.session.handleLine("/status");
    await item.session.handleLine("/permissions");
    await item.session.handleLine("/clear");

    expect(turns).toBe(0);
    expect(item.text()).toContain("/help /status /permissions /undo /clear /exit");
    expect(item.text()).toContain("Provider: mock (fixture)");
    expect(item.text()).toContain("Permission decisions: 0");
    expect(item.permissionState.clears).toBe(1);
  });

  it("runs undo locally and reports that shell side effects are outside its scope", async () => {
    const item = fixture(async ({ transcript }) => ({ transcript, reason: "completed" }));
    const undoCalls: number[] = [];
    const chunks: string[] = [];
    const session = new CliSession({
      input: item.input,
      renderer: new TerminalRenderer({ output: { write: (chunk) => chunks.push(chunk), columns: 200 } }),
      runTurn: async ({ transcript }) => ({ transcript, reason: "completed" }),
      undo: async () => {
        undoCalls.push(1);
        return { status: "undone", paths: ["src/a.ts"] };
      },
      status: {
        provider: "mock",
        model: "fixture",
        workspace: "/workspace",
        trusted: false,
        sandbox: "blocked",
      },
    });

    await session.handleLine("/undo");

    expect(undoCalls).toHaveLength(1);
    expect(chunks.join("")).toContain("Undid Agent file changes: src/a.ts");
    expect(chunks.join("")).toContain("Shell and other external side effects were not reverted");
  });

  it("first Ctrl-C cancels the active turn and idle Ctrl-C exits", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    const item = fixture(async ({ transcript, signal }) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { transcript, reason: "cancelled" };
    });

    const pending = item.session.handleLine("do work");
    await active;
    expect(item.session.handleInterrupt()).toBe("cancelled");
    expect(item.session.closed).toBe(false);
    await pending;
    expect(item.session.transcript.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "do work" }] },
    ]);

    expect(item.session.handleInterrupt()).toBe("exit");
    expect(item.session.closed).toBe(true);
    expect(item.input.closed).toBe(true);
    expect(item.text()).toContain("Cancelling current turn");
  });

  it("clears conversation state and exits through commands", async () => {
    const item = fixture(async ({ transcript }) => ({ transcript, reason: "completed" }));
    await item.session.handleLine("hello");
    expect(item.session.transcript.messages).toHaveLength(1);

    await item.session.handleLine("/clear");
    expect(item.session.transcript.messages).toHaveLength(0);
    await item.session.handleLine("/exit");
    expect(item.session.closed).toBe(true);
  });

  it("durably records user input before starting a turn and persists emitted events", async () => {
    const order: string[] = [];
    const item = fixture(async ({ transcript, emit }) => {
      order.push("turn");
      await emit({
        protocolVersion: 1,
        type: "turn_started",
        turnId: "turn-1",
        sequence: 0,
        timestamp: "2026-07-23T00:00:00.000Z",
      });
      return { transcript, reason: "completed" };
    });
    const session = new CliSession({
      input: item.input,
      renderer: new TerminalRenderer({ output: { write: () => undefined, columns: 200 } }),
      runTurn: async (request) => {
        order.push("runner-entered");
        return await (async () => {
          await request.emit({
            protocolVersion: 1,
            type: "turn_started",
            turnId: "turn-1",
            sequence: 0,
            timestamp: "2026-07-23T00:00:00.000Z",
          });
          return { transcript: request.transcript, reason: "completed" as const };
        })();
      },
      persistence: {
        async persistTranscript(transcript) {
          order.push(`transcript:${transcript.messages.length}`);
        },
        async appendRuntimeEvent(event) {
          order.push(`event:${event.type}`);
        },
      },
      status: {
        provider: "mock",
        model: "fixture",
        workspace: "/workspace",
        trusted: false,
        sandbox: "blocked",
      },
    });

    await session.handleLine("persist me");

    expect(order).toEqual([
      "transcript:1",
      "runner-entered",
      "event:turn_started",
      "transcript:1",
    ]);
  });
});
