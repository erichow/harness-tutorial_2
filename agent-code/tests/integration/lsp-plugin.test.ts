import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLspToolset,
  type LspServerConfiguration,
} from "../../src/extensions/lsp.js";
import { createTranscript } from "../../src/messages/transcript.js";
import type { JsonObject } from "../../src/protocol/json.js";
import { MockProvider, type MockProviderResponse } from "../../src/providers/mock.js";
import { CodingAgentRuntime } from "../../src/runtime/coding-agent.js";
import { WorkspaceTrust } from "../../src/security/trust.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { HostSandboxRunner } from "../../src/tools/shell/sandbox-runner.js";

const temporaryDirectories: string[] = [];
const rpcModule = import.meta.resolve("vscode-jsonrpc/node");
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function fixture(): Promise<{
  readonly root: string;
  readonly sourcePath: string;
  readonly eventPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-code-lsp-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"));
  const sourcePath = join(root, "src/example.ts");
  const eventPath = join(root, "lsp-events.jsonl");
  await writeFile(sourcePath, "export const answer = 42;\n", "utf8");
  return { root, sourcePath, eventPath };
}

function serverConfiguration(
  eventPath: string,
  mode: "normal" | "slow" = "normal",
  timeoutMs = 2_000,
): LspServerConfiguration {
  return {
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      fakeLanguageServer,
      rpcModule,
      eventPath,
      mode,
    ],
    languageIds: { ".ts": "typescript" },
    timeoutMs,
  };
}

function call(id: string, name: string, input: JsonObject) {
  return { type: "tool_call" as const, id, name, input };
}

async function events(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, "utf8");
  return content.trim().split("\n").filter(Boolean).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

function response(...items: MockProviderResponse["events"]): MockProviderResponse {
  return { events: items };
}

describe("optional LSP plugin", () => {
  it("uses mature Content-Length framing and sends correct workspace, document, and position data", async () => {
    const { root, sourcePath, eventPath } = await fixture();
    const toolset = await createLspToolset({
      workspaceRoot: root,
      servers: { typescript: serverConfiguration(eventPath) },
      environment: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: "must-not-reach-language-server",
      },
    });
    try {
      expect(toolset.connectedServers).toEqual(["typescript"]);
      expect(toolset.failures).toEqual({});
      expect(toolset.tools.map(({ definition }) => definition.name))
        .toEqual(["lsp_typescript_query"]);
      const executor = new ToolRegistry(toolset.tools).createExecutor();

      const hover = await executor.execute(call("hover", "lsp_typescript_query", {
        operation: "hover",
        path: "src/example.ts",
        line: 0,
        character: 13,
      }), { signal });
      expect(hover).toMatchObject({
        status: "success",
        data: {
          operation: "hover",
          documentVersion: 1,
          provenance: { trust: "external_untrusted", protocol: "lsp" },
        },
      });
      expect(hover.content).toContain("answer: number");

      await writeFile(sourcePath, "export const answer = 43;\n", "utf8");
      const definition = await executor.execute(call("definition", "lsp_typescript_query", {
        operation: "definition",
        path: "src/example.ts",
        line: 0,
        character: 18,
      }), { signal });
      expect(definition).toMatchObject({
        status: "success",
        data: { operation: "definition", documentVersion: 2 },
      });

      const recorded = await events(eventPath);
      const initialize = recorded.find(({ event }) => event === "initialize");
      const canonicalRoot = await realpath(root);
      const canonicalSource = await realpath(sourcePath);
      const rootUri = pathToFileURL(canonicalRoot).href;
      expect(initialize).toMatchObject({
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: expect.any(String) }],
        secretPresent: false,
      });
      expect(recorded.find(({ event }) => event === "didOpen")).toMatchObject({
        languageId: "typescript",
        version: 1,
        uri: pathToFileURL(canonicalSource).href,
      });
      expect(recorded.find(({ event }) => event === "didChange")).toMatchObject({
        version: 2,
        text: "export const answer = 43;\n",
      });
      expect(recorded.filter(({ event }) => event === "query")).toEqual([
        expect.objectContaining({
          method: "textDocument/hover",
          position: { line: 0, character: 13 },
        }),
        expect.objectContaining({
          method: "textDocument/definition",
          position: { line: 0, character: 18 },
        }),
      ]);
    } finally {
      await toolset.dispose();
    }
    expect(await events(eventPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "shutdown" }),
      expect.objectContaining({ event: "exit" }),
    ]));
  });

  it("cancels timed-out requests and returns an actionable core-tool fallback", async () => {
    const { root, eventPath } = await fixture();
    const toolset = await createLspToolset({
      workspaceRoot: root,
      servers: { slow: serverConfiguration(eventPath, "slow", 300) },
    });
    try {
      const result = await new ToolRegistry(toolset.tools).createExecutor().execute(
        call("slow", "lsp_slow_query", {
          operation: "hover",
          path: "src/example.ts",
          line: 0,
          character: 0,
        }),
        { signal },
      );
      expect(result).toMatchObject({
        status: "error",
        error: {
          code: "execution_failed",
          message: expect.stringContaining("timed out"),
        },
      });
      expect(result.content).toContain("search_text, read_file, and run_tests");
      await expect.poll(async () =>
        (await events(eventPath)).some(({ event }) => event === "cancelled"))
        .toBe(true);
    } finally {
      await toolset.dispose();
    }
  });

  it("omits unavailable LSP tools while the runtime keeps search, read, and test tools", async () => {
    const { root } = await fixture();
    const diagnostics: string[] = [];
    const names: string[][] = [];
    const trust = await WorkspaceTrust.create({ workspaceRoot: root, trustedRoots: [root] });
    const provider = new MockProvider([
      (request) => {
        names.push(request.tools.map(({ name }) => name));
        return response(
          { type: "text_delta", delta: "core tools available" },
          { type: "response_completed", finishReason: "stop" },
        );
      },
    ]);
    const runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot: root,
      shell: { runner: new HostSandboxRunner() },
      extensions: {
        trust,
        lspServers: {
          missing: {
            command: `agent-code-missing-lsp-${String(process.pid)}`,
            languageIds: { ".ts": "typescript" },
            timeoutMs: 100,
          },
        },
        diagnostic: (message) => diagnostics.push(message),
      },
    });
    try {
      const result = await runtime.runTurn({ transcript: createTranscript() });
      expect(result.reason).toBe("completed");
      expect(names[0]).toEqual(expect.arrayContaining([
        "search_text",
        "read_file",
        "run_tests",
      ]));
      expect(names[0]).not.toContain("lsp_missing_query");
      expect(diagnostics).toEqual([
        expect.stringContaining("Falling back to search_text, read_file, run_tests"),
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});

const fakeLanguageServer = String.raw`
import { appendFileSync } from "node:fs";

const rpc = await import(process.argv[1]);
const eventPath = process.argv[2];
const mode = process.argv[3];
const log = (value) => appendFileSync(eventPath, JSON.stringify(value) + "\n");
const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(process.stdin),
  new rpc.StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", (params) => {
  log({
    event: "initialize",
    rootUri: params.rootUri,
    workspaceFolders: params.workspaceFolders,
    secretPresent: process.env.OPENAI_API_KEY !== undefined,
  });
  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
    },
  };
});
connection.onNotification("initialized", () => log({ event: "initialized" }));
connection.onNotification("textDocument/didOpen", (params) => {
  log({
    event: "didOpen",
    uri: params.textDocument.uri,
    languageId: params.textDocument.languageId,
    version: params.textDocument.version,
    text: params.textDocument.text,
  });
});
connection.onNotification("textDocument/didChange", (params) => {
  log({
    event: "didChange",
    uri: params.textDocument.uri,
    version: params.textDocument.version,
    text: params.contentChanges[0].text,
  });
});
for (const [method, result] of [
  ["textDocument/hover", { contents: { kind: "plaintext", value: "answer: number" } }],
  ["textDocument/definition", [{ uri: "file:///definition.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }]],
  ["textDocument/references", []],
  ["textDocument/documentSymbol", []],
]) {
  connection.onRequest(method, (params, token) => {
    log({ event: "query", method, position: params.position, uri: params.textDocument.uri });
    if (mode !== "slow") return result;
    return new Promise((resolve) => {
      token.onCancellationRequested(() => {
        log({ event: "cancelled", method });
        resolve(null);
      });
    });
  });
}
connection.onRequest("shutdown", () => {
  log({ event: "shutdown" });
  return null;
});
connection.onNotification("exit", () => {
  log({ event: "exit" });
  setImmediate(() => process.exit(0));
});
connection.listen();
`;
