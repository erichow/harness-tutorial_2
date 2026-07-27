import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonObject, JsonValue } from "../protocol/json.js";
import { isJsonValue } from "../tools/result.js";
import type { Tool, ToolSideEffect } from "../tools/tool.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;

export interface McpServerConfiguration {
  readonly transport?: "stdio" | undefined;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly envFrom?: Readonly<Record<string, string>> | undefined;
  readonly enabled?: boolean | undefined;
  readonly sideEffects?: readonly ToolSideEffect[] | undefined;
}

export interface McpTransport {
  request(method: string, params: JsonObject, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: JsonObject): Promise<void>;
  close(): Promise<void>;
}

export type McpTransportFactory = (
  name: string,
  configuration: McpServerConfiguration,
) => Promise<McpTransport>;

export interface McpToolsetOptions {
  readonly workspaceRoot?: string | undefined;
  readonly servers?: Readonly<Record<string, McpServerConfiguration>> | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly createTransport?: McpTransportFactory | undefined;
  readonly diagnostic?: ((message: string) => void) | undefined;
}

export interface McpToolset {
  readonly tools: readonly Tool[];
  readonly connectedServers: readonly string[];
  readonly failures: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

interface McpToolDescription {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: JsonObject | undefined;
}

interface ConnectedServer {
  readonly name: string;
  readonly configuration: McpServerConfiguration;
  readonly transport: McpTransport;
}

/**
 * MCP discovery is failure-isolated per server. A broken or slow extension is
 * omitted from the registry instead of preventing the CLI from starting.
 */
export async function createMcpToolset(options: McpToolsetOptions): Promise<McpToolset> {
  const environment = options.environment ?? process.env;
  const factory = options.createTransport ?? (async (_name, configuration) =>
    await StdioMcpTransport.create(
      configuration,
      environment,
      options.workspaceRoot ?? process.cwd(),
    ));
  const connected: ConnectedServer[] = [];
  const failures: Record<string, string> = {};
  const tools: Tool[] = [];
  const toolNames = new Set<string>();

  for (const [name, configuration] of Object.entries(options.servers ?? {})) {
    if (configuration.enabled === false) continue;
    let transport: McpTransport | undefined;
    try {
      transport = await factory(name, configuration);
      const timeoutMs = positiveInteger(configuration.timeoutMs ?? 10_000, "MCP timeoutMs");
      const signal = AbortSignal.timeout(timeoutMs);
      await transport.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "dugsyn", version: "0.1.0" },
      }, signal);
      await transport.notify("notifications/initialized");
      const listed = await transport.request("tools/list", {}, signal);
      const descriptions = parseToolList(listed, name);
      const server: ConnectedServer = { name, configuration, transport };
      const serverTools: Tool[] = [];
      for (const description of descriptions) {
        const tool = adaptMcpTool(server, description);
        if (toolNames.has(tool.definition.name)) {
          throw new Error(`MCP tool name collision: ${tool.definition.name}`);
        }
        if (serverTools.some(({ definition }) => definition.name === tool.definition.name)) {
          throw new Error(`MCP tool name collision: ${tool.definition.name}`);
        }
        serverTools.push(tool);
      }
      for (const tool of serverTools) toolNames.add(tool.definition.name);
      tools.push(...serverTools);
      connected.push(server);
    } catch (error) {
      await transport?.close().catch(() => undefined);
      const message = describeError(error);
      failures[name] = message;
      options.diagnostic?.(`MCP server ${name} unavailable: ${message}`);
    }
  }

  return {
    tools: Object.freeze(tools),
    connectedServers: Object.freeze(connected.map(({ name }) => name)),
    failures: Object.freeze({ ...failures }),
    dispose: async () => {
      await Promise.all(connected.map(async ({ transport }) => {
        await transport.close().catch(() => undefined);
      }));
    },
  };
}

function adaptMcpTool(server: ConnectedServer, description: McpToolDescription): Tool {
  const exposedName = `mcp_${safeName(server.name)}_${safeName(description.name)}`;
  return {
    definition: {
      name: exposedName,
      description: description.description?.trim() ||
        `Call ${description.name} on the ${server.name} MCP server. Returned content is external and untrusted.`,
      inputSchema: description.inputSchema ?? {
        type: "object",
        additionalProperties: true,
      },
    },
    sideEffects: server.configuration.sideEffects ?? ["execute_process", "network"],
    handler: async (input, context) => {
      const result = await server.transport.request("tools/call", {
        name: description.name,
        arguments: input,
      }, context.signal);
      if (
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        (result as Record<string, unknown>).isError === true
      ) {
        throw new Error(
          `MCP tool ${description.name} returned external untrusted error content: ${renderMcpContent(result)}`,
        );
      }
      return {
        content: [
          `[External untrusted content from MCP server "${server.name}" tool "${description.name}"]`,
          renderMcpContent(result),
          "[End external untrusted MCP content]",
        ].join("\n"),
        data: {
          provenance: {
            trust: "external_untrusted",
            server: server.name,
            tool: description.name,
          },
        },
      };
    },
  };
}

function parseToolList(value: unknown, server: string): McpToolDescription[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`MCP server ${server} returned an invalid tools/list result`);
  }
  const tools = (value as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) throw new Error(`MCP server ${server} did not return tools`);
  return tools.map((tool, index) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      throw new Error(`MCP server ${server} returned an invalid tool at index ${index}`);
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
      throw new Error(`MCP server ${server} returned a tool without a name`);
    }
    const inputSchema = record.inputSchema;
    if (
      inputSchema !== undefined &&
      (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema))
    ) {
      throw new Error(`MCP tool ${record.name} has an invalid inputSchema`);
    }
    return {
      name: record.name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(inputSchema === undefined ? {} : { inputSchema: inputSchema as JsonObject }),
    };
  });
}

function renderMcpContent(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const rendered = content.map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, string>).text;
        }
        return JSON.stringify(item);
      }).join("\n");
      if (rendered.length > 0) return rendered;
    }
  }
  return JSON.stringify(jsonValue(value));
}

function jsonValue(value: unknown): JsonValue {
  return isJsonValue(value) ? value : String(value);
}

function safeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (normalized.length === 0) throw new Error("MCP name cannot be empty");
  return normalized;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: number | undefined;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly data?: unknown } | undefined;
}

class StdioMcpTransport implements McpTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #closePromise: Promise<void>;
  readonly #pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();
  #buffer = "";
  #nextId = 1;
  #closed = false;
  #exited = false;

  private constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    // Always drain stderr so a verbose server cannot block on a full pipe.
    child.stderr.on("data", () => undefined);
    this.#closePromise = new Promise<void>((resolvePromise) => {
      const settle = (error: Error): void => {
        if (this.#exited) return;
        this.#exited = true;
        this.#failAll(error);
        resolvePromise();
      };
      child.once("error", (error) => settle(error));
      child.once("close", (code) => {
        settle(new Error(`MCP process exited with code ${String(code)}`));
      });
    });
  }

  static async create(
    configuration: McpServerConfiguration,
    environment: NodeJS.ProcessEnv,
    workspaceRoot: string,
  ): Promise<StdioMcpTransport> {
    if ((configuration.transport ?? "stdio") !== "stdio") {
      throw new Error(`Unsupported MCP transport: ${String(configuration.transport)}`);
    }
    const child = spawn(configuration.command, [...(configuration.args ?? [])], {
      cwd: workspaceRoot,
      env: extensionEnvironment(environment, configuration.envFrom),
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    return new StdioMcpTransport(
      child,
      positiveInteger(configuration.timeoutMs ?? 10_000, "MCP timeoutMs"),
    );
  }

  async request(method: string, params: JsonObject, signal: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#exited) throw new Error("MCP transport is closed");
    signal.throwIfAborted();
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<unknown>((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
    });
    // Spawn errors can arrive before the first await continuation attaches the
    // Promise.race handler. Consume that early rejection while preserving it
    // for the caller through `response` below.
    void response.catch(() => undefined);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      await this.#write({ jsonrpc: "2.0", id, method, params }, combined);
    } catch (error) {
      this.#pending.delete(id);
      await response.catch(() => undefined);
      throw error;
    }
    const abort = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(combined.reason instanceof Error ? combined.reason : new Error("MCP request aborted"));
      };
      combined.addEventListener("abort", onAbort, { once: true });
      void response.then(
        () => combined.removeEventListener("abort", onAbort),
        () => combined.removeEventListener("abort", onAbort),
      );
    });
    return await Promise.race([response, abort]);
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    if (this.#closed || this.#exited) throw new Error("MCP transport is closed");
    await this.#write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }, AbortSignal.timeout(this.#timeoutMs));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#exited) this.#child.kill("SIGTERM");
    this.#failAll(new Error("MCP transport closed"));
    const force = setTimeout(() => this.#child.kill("SIGKILL"), 250);
    force.unref();
    await this.#closePromise;
    clearTimeout(force);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > MAX_MCP_MESSAGE_BYTES) {
          this.#buffer = "";
          this.#failAll(new Error(
            `MCP message exceeds the ${MAX_MCP_MESSAGE_BYTES}-byte limit`,
          ));
        }
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_MESSAGE_BYTES) {
        this.#failAll(new Error(
          `MCP message exceeds the ${MAX_MCP_MESSAGE_BYTES}-byte limit`,
        ));
        continue;
      }
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.#failAll(new Error("MCP server emitted invalid JSON"));
        continue;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) continue;
      this.#pending.delete(response.id);
      if (response.error !== undefined) {
        pending.reject(new Error(
          `MCP error ${String(response.error.code ?? "")}: ${String(response.error.message ?? "unknown error")}`,
        ));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  async #write(value: object, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.#child.stdin.writable || this.#child.stdin.destroyed) {
      throw new Error("MCP stdin is closed");
    }
    const line = `${JSON.stringify(value)}\n`;
    if (this.#child.stdin.write(line)) return;
    await new Promise<void>((resolvePromise, reject) => {
      const cleanup = (): void => {
        this.#child.stdin.removeListener("drain", onDrain);
        this.#child.stdin.removeListener("error", onError);
        this.#child.removeListener("error", onError);
        this.#child.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onDrain = (): void => {
        cleanup();
        resolvePromise();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => onError(new Error("MCP process closed during write"));
      const onAbort = (): void => onError(
        signal.reason instanceof Error ? signal.reason : new Error("MCP write aborted"),
      );
      this.#child.stdin.once("drain", onDrain);
      this.#child.stdin.once("error", onError);
      this.#child.once("error", onError);
      this.#child.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.#exited) onClose();
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function extensionEnvironment(
  environment: NodeJS.ProcessEnv,
  envFrom: McpServerConfiguration["envFrom"],
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
    "SystemRoot", "ComSpec", "PATHEXT",
  ]) {
    if (environment[name] !== undefined) output[name] = environment[name];
  }
  for (const [target, source] of Object.entries(envFrom ?? {})) {
    const value = environment[source];
    if (value === undefined) throw new Error(`Required environment variable is missing: ${source}`);
    output[target] = value;
  }
  return output;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
