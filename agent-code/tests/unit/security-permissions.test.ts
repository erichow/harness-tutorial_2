import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import {
  normalizePermissionRequest,
  PermissionEngine,
  type PermissionRule,
} from "../../src/security/permissions.js";
import { WorkspaceTrust } from "../../src/security/trust.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/tool.js";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-code-permission-"));
}

async function trust(trusted: boolean): Promise<WorkspaceTrust> {
  const root = await workspace();
  return await WorkspaceTrust.create({
    workspaceRoot: root,
    trustedRoots: trusted ? [root] : [],
  });
}

function rule(id: string, action: PermissionRule["action"], options: Partial<PermissionRule> = {}): PermissionRule {
  return { id, action, ...options };
}

function call(id: string, name: string, input: JsonObject) {
  return { type: "tool_call" as const, id, name, input };
}

function pathTool(handler: Tool["handler"] = async () => ({ content: "executed" })): Tool {
  return {
    definition: {
      name: "read_file",
      description: "Test path access",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    sideEffects: ["read_workspace"],
    handler,
  };
}

describe("WorkspaceTrust", () => {
  it("binds trust to a canonical root and gates project-controlled features", async () => {
    const root = await workspace();
    const alias = `${root}-alias`;
    await symlink(root, alias);
    const trusted = await WorkspaceTrust.create({ workspaceRoot: alias, trustedRoots: [root] });
    const untrusted = await WorkspaceTrust.create({ workspaceRoot: root });

    expect(trusted.trusted).toBe(true);
    expect(trusted.workspaceRoot).toBe(await realpath(root));
    expect(trusted.projectFeature("hooks")).toEqual({ enabled: true });
    expect(untrusted.projectFeature("mcp")).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("until the workspace is trusted"),
    });
  });
});

describe("PermissionEngine", () => {
  it.each([".env", ".env.local", "secrets/id_rsa", ".ssh/config", ".aws/credentials"])(
    "denies sensitive resource %s before prompting",
    async (path) => {
      const decide = vi.fn(async () => "allow_once" as const);
      const permissions = new PermissionEngine({ trust: await trust(true), decide });
      const result = await permissions.authorize({
        toolName: "read_file",
        input: { path },
        sideEffects: ["read_workspace"],
      }, new AbortController().signal);

      expect(result).toMatchObject({ kind: "deny", reason: expect.stringContaining("protect-sensitive-paths") });
      expect(decide).not.toHaveBeenCalled();
      expect(permissions.auditLog[0]?.resources).toContain(`sensitive:${path}`);
    },
  );

  it("uses managed deny, user deny, project deny, ask, allow, then default priority", async () => {
    const request = { toolName: "run_shell", input: { command: "npm test" }, sideEffects: ["execute_process"] as const };
    const managed = new PermissionEngine({
      trust: await trust(true),
      managedRules: [rule("managed-stop", "deny", { tools: ["run_shell"] })],
      userRules: [rule("user-go", "allow", { tools: ["run_shell"] })],
    });
    const user = new PermissionEngine({
      trust: await trust(true),
      userRules: [rule("user-stop", "deny", { tools: ["run_shell"] })],
      projectRules: [rule("project-go", "allow", { tools: ["run_shell"] })],
    });
    const project = new PermissionEngine({
      trust: await trust(true),
      userRules: [rule("user-go", "allow", { tools: ["run_shell"] })],
      projectRules: [rule("project-stop", "deny", { tools: ["run_shell"] })],
    });
    const ask = new PermissionEngine({
      trust: await trust(true),
      userRules: [rule("confirm", "ask", { tools: ["run_shell"] })],
      projectRules: [rule("project-go", "allow", { tools: ["run_shell"] })],
      decide: async () => "deny",
    });

    await expect(managed.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("managed-stop") });
    await expect(user.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("user-stop") });
    await expect(project.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("project-stop") });
    await expect(ask.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("User denied") });
  });

  it("never lets project config relax a user deny and ignores project rules before trust", async () => {
    const userDeny = rule("no-network", "deny", { sideEffects: ["network"] });
    const projectAllow = rule("project-network", "allow", { sideEffects: ["network"] });
    const request = { toolName: "run_shell", input: { command: "curl https://example.com" }, sideEffects: ["network"] as const };
    const trusted = new PermissionEngine({
      trust: await trust(true), userRules: [userDeny], projectRules: [projectAllow],
    });
    const untrusted = new PermissionEngine({
      trust: await trust(false), projectRules: [projectAllow], defaultDecision: "deny",
    });

    await expect(trusted.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("user rule no-network") });
    await expect(untrusted.authorize(request, new AbortController().signal)).resolves.toMatchObject({ kind: "deny", reason: "Denied by default policy." });
  });

  it("does not parse project-owned rules before workspace trust", async () => {
    const malformed: PermissionRule = { id: "", action: "allow" };
    const untrusted = await trust(false);
    const trusted = await trust(true);

    expect(() => new PermissionEngine({ trust: untrusted, projectRules: [malformed] })).not.toThrow();
    expect(() => new PermissionEngine({ trust: trusted, projectRules: [malformed] })).toThrow(
      "project rule id must not be empty",
    );
  });

  it("keys session grants by the complete canonical request, not an input prefix", async () => {
    const decide = vi.fn(async () => "allow_session" as const);
    const permissions = new PermissionEngine({ trust: await trust(true), decide });
    const signal = new AbortController().signal;
    const base = "x".repeat(200);
    const first = { toolName: "run_shell", input: { command: `${base}A`, cwd: "." }, sideEffects: ["execute_process"] as const };
    const reordered = { toolName: "run_shell", input: { cwd: ".", command: `${base}A` }, sideEffects: ["execute_process"] as const };
    const different = { toolName: "run_shell", input: { command: `${base}B`, cwd: "." }, sideEffects: ["execute_process"] as const };

    await permissions.authorize(first, signal);
    await permissions.authorize(reordered, signal);
    await permissions.authorize(different, signal);

    expect(decide).toHaveBeenCalledTimes(2);
    expect(permissions.auditLog.map((entry) => entry.scope)).toEqual(["session", "session", "session"]);
    expect(permissions.auditLog[0]?.fingerprint).toBe(permissions.auditLog[1]?.fingerprint);
    expect(permissions.auditLog[2]?.fingerprint).not.toBe(permissions.auditLog[0]?.fingerprint);
  });

  it("classifies outside paths and network domains in one normalized audit request", () => {
    const normalized = normalizePermissionRequest({
      toolName: "run_shell",
      input: { path: "../private.txt", command: "curl https://API.Example.com/v1" },
      sideEffects: ["read_workspace", "network"],
    });

    expect(normalized.resources).toEqual(expect.arrayContaining([
      "effect:read_workspace",
      "effect:network",
      "external:../private.txt",
      "network:*",
      "network:api.example.com",
    ]));
    expect(normalized.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(normalized.input)).toBe(true);
  });

  it("runs permission checks after schema validation and before the handler", async () => {
    const decide = vi.fn(async () => "allow_once" as const);
    const handler = vi.fn<Tool["handler"]>(async () => ({ content: "unexpected" }));
    const permissions = new PermissionEngine({ trust: await trust(true), decide });
    const executor = new ToolRegistry([pathTool(handler)], { permissions }).createExecutor();
    const signal = new AbortController().signal;

    const invalid = await executor.execute(call("invalid", "read_file", {}), { signal });
    const outside = await executor.execute(call("outside", "read_file", { path: "../../secret" }), { signal });
    const ordinary = await executor.execute(call("ordinary", "read_file", { path: "src/index.ts" }), { signal });

    expect(invalid.error?.code).toBe("invalid_arguments");
    expect(outside.error?.code).toBe("permission_denied");
    expect(ordinary.status).toBe("success");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
