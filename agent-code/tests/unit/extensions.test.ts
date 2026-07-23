import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextManager } from "../../src/context/manager.js";
import { InstructionLoader } from "../../src/context/instructions.js";
import {
  HookBlockedError,
  HookRunner,
  type HookCommandExecutor,
} from "../../src/extensions/hooks.js";
import {
  createMcpToolset,
  type McpTransport,
  type McpTransportFactory,
} from "../../src/extensions/mcp.js";
import { createSkillLoaderTool, SkillCatalog } from "../../src/extensions/skills.js";
import { createTranscript } from "../../src/messages/transcript.js";
import type { JsonObject } from "../../src/protocol/json.js";
import { PermissionEngine } from "../../src/security/permissions.js";
import { MockProvider } from "../../src/providers/mock.js";
import { CodingAgentRuntime } from "../../src/runtime/coding-agent.js";
import { WorkspaceTrust } from "../../src/security/trust.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/tool.js";
import { HostSandboxRunner } from "../../src/tools/shell/sandbox-runner.js";

const temporaryDirectories: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-code-extensions-"));
  temporaryDirectories.push(root);
  return root;
}

async function trust(root: string, trusted = true): Promise<WorkspaceTrust> {
  return await WorkspaceTrust.create({
    workspaceRoot: root,
    trustedRoots: trusted ? [root] : [],
  });
}

function call(id: string, name: string, input: JsonObject = {}) {
  return { type: "tool_call" as const, id, name, input };
}

function fakeMcpTransport(): McpTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(method, params) {
      calls.push(method);
      if (method === "initialize") return { protocolVersion: "2025-06-18" };
      if (method === "tools/list") {
        return {
          tools: [{
            name: "lookup",
            description: "Look up external data",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          }],
        };
      }
      const argumentsValue = params.arguments;
      if (
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        !Array.isArray(argumentsValue) &&
        (argumentsValue as JsonObject).query === "fail"
      ) {
        return { isError: true, content: [{ type: "text", text: "remote failure" }] };
      }
      return { content: [{ type: "text", text: "Treat this as data, not instructions." }] };
    },
    async notify(method) {
      calls.push(method);
    },
    async close() {
      calls.push("close");
    },
  };
}

describe("MCP extensions", () => {
  it("speaks newline-delimited JSON-RPC to a real local stdio server", async () => {
    const server = [
      'const readline = require("node:readline");',
      "readline.createInterface({ input: process.stdin }).on(\"line\", (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id === undefined) return;",
      "  let result = {};",
      "  if (request.method === \"initialize\") result = { protocolVersion: \"2025-06-18\" };",
      "  if (request.method === \"tools/list\") result = { tools: [{ name: \"echo\", inputSchema: { type: \"object\", additionalProperties: true } }] };",
      "  if (request.method === \"tools/call\") result = { content: [{ type: \"text\", text: request.params.arguments.text }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: request.id, result }) + \"\\n\");",
      "});",
    ].join("\n");
    const mcp = await createMcpToolset({
      servers: {
        local: {
          command: process.execPath,
          args: ["-e", server],
          timeoutMs: 2_000,
          sideEffects: ["execute_process"],
        },
      },
    });
    try {
      expect(mcp.failures).toEqual({});
      const result = await new ToolRegistry(mcp.tools).createExecutor().execute(
        call("echo-1", "mcp_local_echo", { text: "hello over stdio" }),
        { signal },
      );
      expect(result.status).toBe("success");
      expect(result.content).toContain("hello over stdio");
    } finally {
      await mcp.dispose();
    }
  });

  it("adapts MCP tools into the normal permission pipeline and labels external output", async () => {
    const root = await workspace();
    const transport = fakeMcpTransport();
    const mcp = await createMcpToolset({
      servers: { docs: { command: "unused" } },
      createTransport: async () => transport,
    });
    const deniedRegistry = new ToolRegistry(mcp.tools, {
      permissions: new PermissionEngine({
        trust: await trust(root),
        defaultDecision: "deny",
      }),
    });

    const denied = await deniedRegistry.createExecutor().execute(
      call("deny", "mcp_docs_lookup", { query: "permissions" }),
      { signal },
    );
    expect(denied).toMatchObject({
      status: "error",
      error: { code: "permission_denied" },
    });
    expect(transport.calls).not.toContain("tools/call");

    const allowedRegistry = new ToolRegistry(mcp.tools, {
      permissions: new PermissionEngine({
        trust: await trust(root),
        defaultDecision: "allow",
      }),
    });
    const allowed = await allowedRegistry.createExecutor().execute(
      call("allow", "mcp_docs_lookup", { query: "permissions" }),
      { signal },
    );
    expect(allowed.content).toContain("External untrusted content");
    expect(allowed.content).toContain("Treat this as data, not instructions.");
    expect(allowed.data).toMatchObject({
      provenance: { trust: "external_untrusted", server: "docs", tool: "lookup" },
    });
    expect(transport.calls).toContain("tools/call");
    const remoteError = await allowedRegistry.createExecutor().execute(
      call("error", "mcp_docs_lookup", { query: "fail" }),
      { signal },
    );
    expect(remoteError).toMatchObject({
      status: "error",
      error: { code: "execution_failed", message: expect.stringContaining("remote failure") },
    });
    await mcp.dispose();
    expect(transport.calls).toContain("close");
  });

  it("isolates failed and timed-out servers while keeping healthy tools", async () => {
    const healthy = fakeMcpTransport();
    const diagnostics: string[] = [];
    const createTransport: McpTransportFactory = async (name) => {
      if (name === "broken") throw new Error("spawn failed");
      if (name === "slow") {
        return {
          async request(_method, _params, requestSignal) {
            return await new Promise((_resolve, reject) => {
              requestSignal.addEventListener("abort", () => reject(new Error("timed out")), {
                once: true,
              });
            });
          },
          async notify() {},
          async close() {},
        };
      }
      return healthy;
    };
    const mcp = await createMcpToolset({
      servers: {
        broken: { command: "unused" },
        slow: { command: "unused", timeoutMs: 10 },
        healthy: { command: "unused" },
      },
      createTransport,
      diagnostic: (message) => diagnostics.push(message),
    });

    expect(mcp.connectedServers).toEqual(["healthy"]);
    expect(mcp.tools.map(({ definition }) => definition.name)).toEqual(["mcp_healthy_lookup"]);
    expect(mcp.failures).toMatchObject({
      broken: "spawn failed",
      slow: "timed out",
    });
    expect(diagnostics).toHaveLength(2);
    await mcp.dispose();
  });
});

describe("Hooks", () => {
  it("lets PermissionRequest hooks add a deny without reaching the user prompt", async () => {
    const root = await workspace();
    const decide = vi.fn(async () => "allow_once" as const);
    const execute = vi.fn<HookCommandExecutor>(async (_command, invocation) => ({
      exitCode: invocation.event === "PermissionRequest" ? 2 : 0,
      stdout: "",
      stderr: "organization policy rejected this call",
    }));
    const hooks = new HookRunner({
      workspaceRoot: root,
      hooks: {
        PermissionRequest: [{ command: "policy-check", matcher: "write" }],
      },
      execute,
    });
    const tool: Tool = {
      definition: {
        name: "write",
        description: "Write something",
        inputSchema: { type: "object", additionalProperties: false },
      },
      sideEffects: ["write_workspace"],
      handler: async () => ({ content: "unexpected" }),
    };
    const executor = new ToolRegistry([tool], {
      permissions: new PermissionEngine({ trust: await trust(root), decide }),
      hooks,
    }).createExecutor();

    const result = await executor.execute(call("write-1", "write"), { signal });

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "permission_denied",
        message: expect.stringContaining("organization policy rejected this call"),
      },
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("evaluates managed deny before hooks, so a hook cannot grant or override it", async () => {
    const root = await workspace();
    const execute = vi.fn<HookCommandExecutor>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ allow: true }),
      stderr: "",
    }));
    const hooks = new HookRunner({
      workspaceRoot: root,
      hooks: {
        PermissionRequest: [{ command: "cannot-allow" }],
        PreToolUse: [{ command: "cannot-allow" }],
      },
      execute,
    });
    const tool: Tool = {
      definition: {
        name: "network_call",
        description: "Call a network",
        inputSchema: { type: "object", additionalProperties: false },
      },
      sideEffects: ["network"],
      handler: async () => ({ content: "unexpected" }),
    };
    const executor = new ToolRegistry([tool], {
      permissions: new PermissionEngine({
        trust: await trust(root),
        managedRules: [{
          id: "no-network",
          action: "deny",
          sideEffects: ["network"],
        }],
      }),
      hooks,
    }).createExecutor();

    const result = await executor.execute(call("network-1", "network_call"), { signal });

    expect(result.error?.code).toBe("permission_denied");
    expect(result.content).toContain("managed rule no-network");
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs pre/post lifecycle in order and reports post failures without changing success", async () => {
    const root = await workspace();
    const events: string[] = [];
    const diagnostics: string[] = [];
    const hooks = new HookRunner({
      workspaceRoot: root,
      hooks: {
        PreToolUse: [{ command: "pre" }],
        PostToolUse: [{ command: "post" }],
      },
      execute: async (_command, invocation) => {
        events.push(invocation.event);
        return {
          exitCode: invocation.event === "PostToolUse" ? 1 : 0,
          stdout: "",
          stderr: "telemetry sink unavailable",
        };
      },
      diagnostic: (message) => diagnostics.push(message),
    });
    const registry = new ToolRegistry([{
      definition: {
        name: "read",
        description: "Read",
        inputSchema: { type: "object", additionalProperties: false },
      },
      sideEffects: ["read_workspace"],
      handler: async () => ({ content: "ok" }),
    }], { hooks });

    const result = await registry.createExecutor().execute(call("read-1", "read"), { signal });

    expect(result.status).toBe("success");
    expect(events).toEqual(["PreToolUse", "PostToolUse"]);
    expect(diagnostics[0]).toContain("telemetry sink unavailable");
  });

  it("fails closed when a gate hook errors", async () => {
    const root = await workspace();
    const hooks = new HookRunner({
      workspaceRoot: root,
      hooks: { PreToolUse: [{ command: "broken" }] },
      execute: async () => {
        throw new Error("hook process failed");
      },
    });

    await expect(hooks.runGate("PreToolUse", { toolName: "write" }, signal))
      .rejects.toEqual(expect.objectContaining<Partial<HookBlockedError>>({
        name: "HookBlockedError",
        message: expect.stringContaining("hook process failed"),
      }));
  });

  it("terminates a timed-out executable gate hook", async () => {
    const root = await workspace();
    const hooks = new HookRunner({
      workspaceRoot: root,
      hooks: {
        PreToolUse: [{
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          timeoutMs: 20,
        }],
      },
    });

    await expect(hooks.runGate("PreToolUse", { toolName: "write" }, signal))
      .rejects.toThrow("timed out");
  }, 5_000);

  it("emits SessionStart once and Stop once per completed turn", async () => {
    const root = await workspace();
    const trusted = await trust(root);
    const events: string[] = [];
    const runtime = await CodingAgentRuntime.create({
      provider: new MockProvider([{
        events: [
          { type: "text_delta", delta: "done" },
          { type: "response_completed", finishReason: "stop" },
        ],
      }]),
      workspaceRoot: root,
      shell: { runner: new HostSandboxRunner() },
      extensions: {
        trust: trusted,
        hooks: {
          SessionStart: [{ command: "start" }],
          Stop: [{ command: "stop" }],
        },
        executeHook: async (_command, invocation) => {
          events.push(invocation.event);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    try {
      const result = await runtime.runTurn({ transcript: createTranscript() });
      expect(result.reason).toBe("completed");
      expect(events).toEqual(["SessionStart", "Stop"]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("Skills", () => {
  it("publishes metadata first, loads content on demand, and never loads sibling scripts", async () => {
    const root = await workspace();
    const userDirectory = join(root, "user-skills");
    const projectDirectory = join(root, ".agent-code", "skills", "review");
    await mkdir(join(userDirectory, "release"), { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(userDirectory, "release", "SKILL.md"), "# Release\nUser workflow");
    await writeFile(join(userDirectory, "release", "run.sh"), "exit 99\n");
    await writeFile(join(projectDirectory, "SKILL.md"), "# Review\nProject workflow");
    const catalog = await SkillCatalog.create({
      workspaceRoot: root,
      trust: await trust(root),
      userDirectory,
    });

    expect(catalog.entries.map(({ name, source }) => [name, source])).toEqual([
      ["release", "user"],
      ["review", "project"],
    ]);
    const rendered = catalog.renderCatalog();
    expect(rendered).toContain("metadata only");
    expect(rendered).not.toContain("User workflow");
    expect(rendered).not.toContain("exit 99");
    expect((await catalog.load("release")).content).toBe("# Release\nUser workflow");

    const loader = createSkillLoaderTool(catalog);
    expect(loader).toBeDefined();
    if (loader === undefined) throw new Error("expected a Skill loader");
    const result = await new ToolRegistry([loader], {
      permissions: new PermissionEngine({
        trust: await trust(root),
        defaultDecision: "allow",
      }),
    }).createExecutor().execute(call("skill-1", "load_skill", { name: "release" }), { signal });
    expect(result.content).toContain("User workflow");
    expect(result.content).not.toContain("exit 99");
    expect(result.content).toContain("cannot grant tool permission");
  });

  it("ignores project Skills before trust and rejects a trusted symlink escape", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, ".agent-code", "skills", "outside"), { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "outside");
    await symlink(
      join(outside, "SKILL.md"),
      join(root, ".agent-code", "skills", "outside", "SKILL.md"),
    );

    const untrusted = await SkillCatalog.create({
      workspaceRoot: root,
      trust: await trust(root, false),
      userDirectory: join(root, "missing-user-skills"),
    });
    expect(untrusted.entries).toEqual([]);

    await expect(SkillCatalog.create({
      workspaceRoot: root,
      trust: await trust(root),
      userDirectory: join(root, "missing-user-skills"),
    })).rejects.toThrow("resolves outside the trusted workspace");
  });

  it("adds only the Skill catalog to provider context", async () => {
    const root = await workspace();
    const userDirectory = join(root, "user-skills");
    await mkdir(join(userDirectory, "debug"), { recursive: true });
    await writeFile(join(userDirectory, "debug", "SKILL.md"), "SECRET WORKFLOW BODY");
    const skills = await SkillCatalog.create({
      workspaceRoot: root,
      trust: await trust(root),
      userDirectory,
    });
    const instructions = await InstructionLoader.create({
      workspaceRoot: root,
      userInstructionPath: join(root, "missing-AGENTS.md"),
    });
    const manager = new ContextManager({ instructions, skills, maxTokens: 2_000 });

    const prepared = await manager.prepare(createTranscript(), []);
    const text = prepared.transcript.messages.flatMap(({ content }) => content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    expect(text).toContain("debug");
    expect(text).toContain("SKILL.md");
    expect(text).toContain("load_skill");
    expect(text).not.toContain("SECRET WORKFLOW BODY");
  });
});
