import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";

import type { JsonValue } from "../protocol/json.js";
import { WorkspacePathGuard } from "../tools/files/path-guard.js";
import { decodeUtf8 } from "../tools/files/text.js";
import type { Tool } from "../tools/tool.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DOCUMENT_BYTES = 1_048_576;
const FALLBACK_TOOLS = ["search_text", "read_file", "run_tests"] as const;

export type LspOperation = "hover" | "definition" | "references" | "document_symbols";

export interface LspServerConfiguration {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  /** Maps a file suffix such as ".ts" to an LSP language id such as "typescript". */
  readonly languageIds: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | undefined;
  readonly maxDocumentBytes?: number | undefined;
  readonly envFrom?: Readonly<Record<string, string>> | undefined;
  readonly initializationOptions?: JsonValue | undefined;
  readonly enabled?: boolean | undefined;
}

export interface LspClient {
  initialize(): Promise<void>;
  query(
    operation: LspOperation,
    path: string,
    position: { readonly line: number; readonly character: number } | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly result: JsonValue; readonly documentVersion: number }>;
  close(): Promise<void>;
}

export type LspClientFactory = (
  name: string,
  configuration: LspServerConfiguration,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
) => Promise<LspClient>;

export interface LspToolsetOptions {
  readonly workspaceRoot: string;
  readonly servers?: Readonly<Record<string, LspServerConfiguration>> | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly createClient?: LspClientFactory | undefined;
  readonly diagnostic?: ((message: string) => void) | undefined;
}

export interface LspToolset {
  readonly tools: readonly Tool[];
  readonly connectedServers: readonly string[];
  readonly failures: Readonly<Record<string, string>>;
  /** Core tools that remain usable when every configured LSP server fails. */
  readonly fallbackTools: readonly string[];
  dispose(): Promise<void>;
}

interface ConnectedServer {
  readonly name: string;
  readonly client: LspClient;
}

/**
 * LSP is a failure-isolated enhancement. A missing executable, bad handshake,
 * or slow server removes only that server's query tool.
 */
export async function createLspToolset(options: LspToolsetOptions): Promise<LspToolset> {
  const environment = options.environment ?? process.env;
  const factory = options.createClient ?? (async (_name, configuration, workspaceRoot, env) =>
    await StdioLspClient.create(configuration, workspaceRoot, env));
  const connected: ConnectedServer[] = [];
  const failures: Record<string, string> = {};
  const tools: Tool[] = [];

  for (const [name, configuration] of Object.entries(options.servers ?? {})) {
    if (configuration.enabled === false) continue;
    let client: LspClient | undefined;
    try {
      validateConfiguration(configuration);
      client = await factory(name, configuration, options.workspaceRoot, environment);
      await client.initialize();
      connected.push({ name, client });
      tools.push(createLspQueryTool(name, client));
    } catch (error) {
      await client?.close().catch(() => undefined);
      const message = describeError(error);
      failures[name] = message;
      options.diagnostic?.(
        `LSP server ${name} unavailable: ${message}. Falling back to ${FALLBACK_TOOLS.join(", ")}.`,
      );
    }
  }

  return Object.freeze({
    tools: Object.freeze(tools),
    connectedServers: Object.freeze(connected.map(({ name }) => name)),
    failures: Object.freeze({ ...failures }),
    fallbackTools: FALLBACK_TOOLS,
    dispose: async () => {
      await Promise.all(connected.map(async ({ client }) => {
        await client.close().catch(() => undefined);
      }));
    },
  });
}

function createLspQueryTool(name: string, client: LspClient): Tool {
  const toolName = `lsp_${safeName(name)}_query`;
  return {
    definition: {
      name: toolName,
      description: [
        `Query the ${name} language server for hover, definition, references, or document symbols.`,
        "Paths are workspace-relative; line and character are zero-based UTF-16 positions.",
        "Results are auxiliary, untrusted analysis. Confirm important findings by reading code and running tests.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["hover", "definition", "references", "document_symbols"],
          },
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          line: { type: "integer", minimum: 0 },
          character: { type: "integer", minimum: 0 },
        },
        required: ["operation", "path"],
        additionalProperties: false,
      },
    },
    sideEffects: ["read_workspace", "execute_process"],
    async handler(input, context) {
      const operation = lspOperation(input.operation);
      const path = stringValue(input.path, "path");
      const position = operation === "document_symbols"
        ? undefined
        : {
            line: nonNegativeInteger(input.line, "line"),
            character: nonNegativeInteger(input.character, "character"),
          };
      const response = await client.query(operation, path, position, context.signal);
      return {
        content: [
          `[Untrusted LSP analysis from server "${name}"]`,
          JSON.stringify(response.result, null, 2),
          "[End untrusted LSP analysis]",
        ].join("\n"),
        data: {
          provenance: {
            trust: "external_untrusted",
            server: name,
            protocol: "lsp",
          },
          path,
          operation,
          documentVersion: response.documentVersion,
        },
      };
    },
  };
}

interface OpenDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
  readonly version: number;
}

class StdioLspClient implements LspClient {
  readonly #configuration: LspServerConfiguration;
  readonly #workspaceRoot: string;
  readonly #workspaceUri: string;
  readonly #guard: WorkspacePathGuard;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: MessageConnection;
  readonly #closePromise: Promise<void>;
  readonly #documents = new Map<string, OpenDocument>();
  #initialized = false;
  #closed = false;
  #exited = false;

  private constructor(
    configuration: LspServerConfiguration,
    guard: WorkspacePathGuard,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.#configuration = configuration;
    this.#workspaceRoot = guard.root;
    this.#workspaceUri = pathToFileURL(guard.root).href;
    this.#guard = guard;
    this.#child = child;
    const reader = new StreamMessageReader(child.stdout);
    const writer = new StreamMessageWriter(child.stdin);
    this.#connection = createMessageConnection(reader, writer);
    this.#connection.onRequest("workspace/configuration", () => []);
    this.#connection.onRequest("client/registerCapability", () => null);
    this.#connection.onRequest("client/unregisterCapability", () => null);
    this.#connection.onError(([error]) => {
      if (!this.#closed) this.#terminate(error);
    });
    this.#connection.onClose(() => {
      this.#exited = true;
    });
    this.#connection.listen();
    // Always drain stderr so a verbose language server cannot block on a full pipe.
    child.stderr.on("data", () => undefined);
    this.#closePromise = new Promise<void>((resolvePromise) => {
      const settle = (): void => {
        this.#exited = true;
        resolvePromise();
      };
      child.once("error", settle);
      child.once("close", settle);
    });
  }

  static async create(
    configuration: LspServerConfiguration,
    workspaceRoot: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<StdioLspClient> {
    const guard = await WorkspacePathGuard.create(workspaceRoot);
    const child = spawn(configuration.command, [...(configuration.args ?? [])], {
      cwd: guard.root,
      env: extensionEnvironment(environment, configuration.envFrom),
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    return new StdioLspClient(configuration, guard, child);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const result = await this.#request("initialize", {
      processId: process.pid,
      clientInfo: { name: "agent-code", version: "0.1.0" },
      rootUri: this.#workspaceUri,
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        },
      },
      workspaceFolders: [{
        uri: this.#workspaceUri,
        name: basename(this.#workspaceRoot),
      }],
      ...(this.#configuration.initializationOptions === undefined
        ? {}
        : { initializationOptions: this.#configuration.initializationOptions }),
    }, AbortSignal.timeout(timeoutMs(this.#configuration)));
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("LSP initialize returned an invalid result");
    }
    await this.#connection.sendNotification("initialized", {});
    this.#initialized = true;
  }

  async query(
    operation: LspOperation,
    path: string,
    position: { readonly line: number; readonly character: number } | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly result: JsonValue; readonly documentVersion: number }> {
    if (!this.#initialized || this.#closed || this.#exited) {
      throw new Error("LSP client is unavailable; use search_text, read_file, and run_tests");
    }
    const document = await this.#synchronizeDocument(path, signal);
    const textDocument = { uri: document.uri };
    const params = operation === "document_symbols"
      ? { textDocument }
      : {
          textDocument,
          position: position ?? missingPosition(),
          ...(operation === "references"
            ? { context: { includeDeclaration: true } }
            : {}),
        };
    const method = {
      hover: "textDocument/hover",
      definition: "textDocument/definition",
      references: "textDocument/references",
      document_symbols: "textDocument/documentSymbol",
    }[operation];
    try {
      const result = await this.#request(method, params, signal);
      return {
        result: jsonValue(result),
        documentVersion: document.version,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        `LSP ${operation} failed: ${describeError(error)}. Use search_text, read_file, and run_tests.`,
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#exited && this.#initialized) {
      await this.#request(
        "shutdown",
        {},
        AbortSignal.timeout(Math.min(timeoutMs(this.#configuration), 1_000)),
        true,
      ).catch(() => undefined);
      await this.#connection.sendNotification("exit").catch(() => undefined);
      await Promise.race([
        this.#closePromise,
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, 250);
          timer.unref();
        }),
      ]);
    }
    this.#connection.dispose();
    if (!this.#exited) this.#child.kill("SIGTERM");
    const force = setTimeout(() => this.#child.kill("SIGKILL"), 250);
    force.unref();
    await this.#closePromise;
    clearTimeout(force);
  }

  async #synchronizeDocument(path: string, signal: AbortSignal): Promise<OpenDocument> {
    signal.throwIfAborted();
    const resolved = await this.#guard.resolveExisting(path);
    const metadata = await stat(resolved.realPath);
    if (!metadata.isFile()) throw new Error("LSP path must be a regular file");
    const maxBytes = positiveInteger(
      this.#configuration.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      "LSP maxDocumentBytes",
    );
    if (metadata.size > maxBytes) {
      throw new Error(`LSP document exceeds the ${maxBytes}-byte limit`);
    }
    const buffer = await readFile(resolved.realPath);
    signal.throwIfAborted();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`LSP document exceeds the ${maxBytes}-byte limit`);
    }
    const text = decodeUtf8(buffer).text;
    const uri = pathToFileURL(resolved.realPath).href;
    const languageId = languageIdFor(resolved.relativePath, this.#configuration.languageIds);
    const existing = this.#documents.get(resolved.realPath);
    if (existing === undefined) {
      const opened = { uri, languageId, text, version: 1 };
      await this.#connection.sendNotification("textDocument/didOpen", {
        textDocument: opened,
      });
      this.#documents.set(resolved.realPath, opened);
      return opened;
    }
    if (existing.text === text) return existing;
    const changed = { ...existing, text, version: existing.version + 1 };
    await this.#connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: changed.version },
      contentChanges: [{ text }],
    });
    this.#documents.set(resolved.realPath, changed);
    return changed;
  }

  async #request(
    method: string,
    params: object,
    signal: AbortSignal,
    allowClosing = false,
  ): Promise<unknown> {
    if ((!allowClosing && this.#closed) || this.#exited) throw new Error("LSP transport is closed");
    signal.throwIfAborted();
    const requestTimeoutMs = timeoutMs(this.#configuration);
    const source = new CancellationTokenSource();
    const timer = setTimeout(() => {
      source.cancel();
    }, requestTimeoutMs);
    timer.unref();
    const abort = (): void => source.cancel();
    signal.addEventListener("abort", abort, { once: true });
    const request = this.#connection.sendRequest<unknown>(method, params, source.token);
    void request.catch(() => undefined);
    const cancelled = new Promise<never>((_resolve, reject) => {
      source.token.onCancellationRequested(() => {
        reject(signal.aborted
          ? abortReason(signal)
          : new Error(`LSP request ${method} timed out after ${requestTimeoutMs} ms`));
      });
    });
    try {
      return await Promise.race([request, cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      source.dispose();
    }
  }

  #terminate(_error: Error): void {
    if (!this.#exited) this.#child.kill("SIGTERM");
  }
}

function languageIdFor(
  path: string,
  languageIds: Readonly<Record<string, string>>,
): string {
  const suffix = Object.keys(languageIds)
    .filter((candidate) => path.endsWith(candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (suffix === undefined) {
    throw new Error(`No configured LSP language id matches ${path}`);
  }
  return languageIds[suffix] as string;
}

function validateConfiguration(configuration: LspServerConfiguration): void {
  if (configuration.command.trim().length === 0) throw new Error("LSP command cannot be empty");
  if (Object.keys(configuration.languageIds).length === 0) {
    throw new Error("LSP languageIds cannot be empty");
  }
  for (const [suffix, languageId] of Object.entries(configuration.languageIds)) {
    if (!suffix.startsWith(".") || suffix.length < 2) {
      throw new Error(`Invalid LSP file suffix: ${suffix}`);
    }
    if (languageId.trim().length === 0) {
      throw new Error(`LSP language id cannot be empty for suffix ${suffix}`);
    }
  }
  timeoutMs(configuration);
  if (configuration.maxDocumentBytes !== undefined) {
    positiveInteger(configuration.maxDocumentBytes, "LSP maxDocumentBytes");
  }
}

function extensionEnvironment(
  environment: NodeJS.ProcessEnv,
  envFrom: LspServerConfiguration["envFrom"],
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

function timeoutMs(configuration: LspServerConfiguration): number {
  return positiveInteger(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS, "LSP timeoutMs");
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return String(value);
}

function lspOperation(value: JsonValue | undefined): LspOperation {
  if (
    value === "hover" ||
    value === "definition" ||
    value === "references" ||
    value === "document_symbols"
  ) return value;
  throw new TypeError("operation must be a supported LSP query");
}

function stringValue(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function nonNegativeInteger(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function missingPosition(): never {
  throw new TypeError("line and character are required for this LSP operation");
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`Invalid LSP server name: ${value}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
