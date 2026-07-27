import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfiguration } from "../../src/config/loader.js";
import { PluginCatalog } from "../../src/extensions/plugin.js";
import {
  createIdeTransportAdapter,
  createWebSocketTransportAdapter,
  HostSessionAdapter,
} from "../../src/hosts/adapter.js";
import {
  HOST_PROTOCOL_VERSION,
  toPublicRuntimeEvent,
  type HostCommand,
  type HostEvent,
} from "../../src/hosts/protocol.js";
import {
  createAuditRecord,
  RemoteAuditExporter,
} from "../../src/observability/exporter.js";
import {
  assertHostAllowed,
  createManagedPluginCatalog,
} from "../../src/security/team-policy.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";

const temporaryDirectories: string[] = [];
const base = {
  protocolVersion: 1 as const,
  timestamp: "2026-07-23T00:00:00.000Z",
  turnId: "turn-1",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (path) => await rm(path, { recursive: true, force: true }),
  ));
});

describe("host adapters", () => {
  it("uses the same versioned contract for IDE and WebSocket transports", async () => {
    const commands: HostCommand[] = [
      { protocolVersion: HOST_PROTOCOL_VERSION, type: "hello", client: "test-ide" },
      {
        protocolVersion: HOST_PROTOCOL_VERSION,
        type: "start_turn",
        requestId: "request-1",
        prompt: "inspect",
      },
    ];
    const events: HostEvent[] = [];
    let closeCalls = 0;
    const transport = createIdeTransportAdapter({
      messages: from(commands),
      send(event) { events.push(event); },
      close() { closeCalls += 1; },
    });
    const adapter = new HostSessionAdapter({
      transport,
      runner: {
        async runTurn({ emit }) {
          await emit({
            ...base,
            sequence: 0,
            type: "tool_call_started",
            call: {
              type: "tool_call",
              id: "call-1",
              name: "run_shell",
              input: { command: "echo secret-value" },
            },
          });
          return { turnId: "turn-1", reason: "completed" };
        },
      },
    });

    await adapter.serve();

    expect(transport.kind).toBe("ide");
    expect(createWebSocketTransportAdapter({
      messages: from([]),
      send() {},
      close() {},
    }).kind).toBe("websocket");
    expect(events.map((event) => event.type)).toEqual([
      "ready",
      "runtime_event",
      "turn_result",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
    expect(closeCalls).toBe(1);
    await adapter.close();
    expect(closeCalls).toBe(1);
  });

  it("rejects incompatible messages and propagates cancellation during a turn", async () => {
    const messages = from([
      { protocolVersion: 99, type: "hello", client: "old" },
      { protocolVersion: 1, type: "start_turn", requestId: "early", prompt: "no" },
      { protocolVersion: 1, type: "hello", client: "editor" },
      { protocolVersion: 1, type: "start_turn", requestId: "active", prompt: "wait" },
      { protocolVersion: 1, type: "cancel_turn", requestId: "active" },
    ]);
    const events: HostEvent[] = [];
    const adapter = new HostSessionAdapter({
      transport: createWebSocketTransportAdapter({
        messages,
        send(event) { events.push(event); },
        close() {},
      }),
      runner: {
        async runTurn({ signal }) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { turnId: "never", reason: "completed" };
        },
      },
    });

    await adapter.serve();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "protocol_error", code: "invalid_message" }),
      expect.objectContaining({ type: "protocol_error", code: "handshake_required" }),
      expect.objectContaining({ type: "turn_result", requestId: "active", reason: "cancelled" }),
    ]));
  });

  it("redacts tool payloads, result content, and error messages", () => {
    const events: RuntimeEvent[] = [
      {
        ...base,
        sequence: 0,
        type: "tool_call_started",
        call: {
          type: "tool_call",
          id: "call-1",
          name: "read_file",
          input: { path: ".env.local", token: "provider-secret" },
        },
      },
      {
        ...base,
        sequence: 1,
        type: "tool_call_finished",
        result: {
          type: "tool_result",
          toolCallId: "call-1",
          status: "error",
          content: "provider-secret",
          error: { code: "execution_failed", message: "provider-secret", retryable: false },
        },
      },
      {
        ...base,
        sequence: 2,
        type: "error",
        category: "provider",
        message: "provider-secret",
        retryable: false,
      },
    ];

    const serialized = JSON.stringify(events.map(toPublicRuntimeEvent));
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain(".env.local");
    expect(serialized).toContain("execution_failed");
  });
});

describe("plugin and managed team policy", () => {
  it("validates manifests before loading code and enforces capability policy", () => {
    const catalog = new PluginCatalog({
      allowedIds: ["com.example.ide"],
      deniedCapabilities: ["provider"],
    });
    expect(catalog.add({
      apiVersion: 1,
      id: "com.example.ide",
      name: "Example IDE",
      version: "1.0.0",
      entrypoint: "dist/index.js",
      capabilities: ["ide_transport"],
    }).id).toBe("com.example.ide");
    expect(() => catalog.add({
      apiVersion: 1,
      id: "com.example.other",
      name: "Other",
      version: "1.0.0",
      entrypoint: "index.js",
      capabilities: ["tool"],
    })).toThrow("not allowed");
    expect(() => new PluginCatalog({ deniedCapabilities: ["provider"] }).add({
      apiVersion: 1,
      id: "com.example.provider",
      name: "Provider",
      version: "1.0.0",
      entrypoint: "../escape.js",
      capabilities: ["provider"],
    })).toThrow("entrypoint");
  });

  it("accepts team policy only from managed configuration", async () => {
    const root = await temporaryDirectory();
    const configDirectory = join(root, ".dugsyn");
    const managed = join(root, "managed.json");
    const user = join(root, "user.json");
    const project = join(configDirectory, "config.json");
    const local = join(configDirectory, "config.local.json");
    await mkdir(configDirectory, { recursive: true });
    await json(managed, {
      trustedWorkspaces: [root],
      teamPolicy: {
        plugins: {
          allowedIds: ["com.example.ide"],
          deniedCapabilities: ["provider"],
        },
        hosts: { allowedKinds: ["cli", "ide"] },
        audit: {
          endpoint: "https://audit.example.test/events",
          headersFrom: { authorization: "AUDIT_TOKEN" },
          failureMode: "closed",
        },
      },
    });
    const configuration = await loadConfiguration({
      workspaceRoot: root,
      environment: {},
      paths: { managed, user, project, local },
    });

    expect(configuration.teamPolicy.hosts?.allowedKinds).toEqual(["cli", "ide"]);
    expect(() => assertHostAllowed(configuration, "websocket"))
      .toThrow("disabled by managed");
    expect(createManagedPluginCatalog(configuration).add({
      apiVersion: 1,
      id: "com.example.ide",
      name: "IDE",
      version: "1.0.0",
      entrypoint: "index.js",
      capabilities: ["ide_transport"],
    }).id).toBe("com.example.ide");

    await json(user, {
      teamPolicy: { hosts: { allowedKinds: ["websocket"] } },
    });
    await expect(loadConfiguration({
      workspaceRoot: root,
      environment: {},
      paths: { managed, user, project, local },
    })).rejects.toThrow("only managed configuration");
  });
});

describe("remote audit exporter", () => {
  it("exports redacted metadata without prompts, tool bodies, or auth values", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return new Response("", { status: 204 });
    });
    const exporter = new RemoteAuditExporter({
      endpoint: "https://audit.example.test/events",
      sessionId: "session-1",
      headers: { authorization: "Bearer audit-secret" },
      fetch: fetchMock,
    });
    const event: RuntimeEvent = {
      ...base,
      sequence: 0,
      type: "tool_call_started",
      call: {
        type: "tool_call",
        id: "call-1",
        name: "run_shell",
        input: { command: "upload provider-secret" },
      },
    };
    const record = exporter.record(event);

    await exporter.export(record, new AbortController().signal);

    expect(record).toEqual(createAuditRecord("session-1", event));
    expect(record.attributes).toEqual({ toolName: "run_shell" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://audit.example.test/events");
    expect(String(requests[0]?.init?.body)).not.toContain("provider-secret");
    expect(String(requests[0]?.init?.body)).not.toContain("audit-secret");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer audit-secret",
      "content-type": "application/json",
    });
  });

  it("supports explicit fail-open and fail-closed behavior", async () => {
    const diagnostic = vi.fn();
    const failingFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const event: RuntimeEvent = {
      ...base,
      sequence: 0,
      type: "turn_started",
    };
    const open = new RemoteAuditExporter({
      endpoint: "https://audit.example.test/events",
      sessionId: "session",
      fetch: failingFetch,
      diagnostic,
    });
    await expect(open.export(open.record(event), new AbortController().signal))
      .resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("offline"));

    const closed = new RemoteAuditExporter({
      endpoint: "https://audit.example.test/events",
      sessionId: "session",
      fetch: failingFetch,
      failureMode: "closed",
    });
    await expect(closed.export(closed.record(event), new AbortController().signal))
      .rejects.toThrow("Remote audit export failed");
  });
});

async function* from(values: readonly unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
    await Promise.resolve();
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dugsyn-hosts-"));
  temporaryDirectories.push(path);
  return path;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
