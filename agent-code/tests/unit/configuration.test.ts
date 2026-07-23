import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadConfiguration,
  type ConfigurationPaths,
} from "../../src/config/loader.js";
import { runSessionCli } from "../../src/cli/session-command.js";
import { PermissionEngine } from "../../src/security/permissions.js";
import { SessionStore } from "../../src/sessions/store.js";

async function fixture(): Promise<{
  root: string;
  paths: ConfigurationPaths & {
    managed: string;
    user: string;
    project: string;
    local: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-code-config-"));
  const configurationDirectory = join(root, ".agent-code");
  await mkdir(configurationDirectory);
  return {
    root,
    paths: {
      managed: join(root, "managed.json"),
      user: join(root, "user.json"),
      project: join(configurationDirectory, "config.json"),
      local: join(configurationDirectory, "config.local.json"),
    },
  };
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("layered configuration", () => {
  it("loads managed, user, project, and local in order after global trust", async () => {
    const { root, paths } = await fixture();
    const secondTrustedRoot = await mkdtemp(join(tmpdir(), "agent-code-config-trusted-"));
    await json(paths.managed, {
      provider: "openai",
      models: { openai: "managed-openai", deepseek: "managed-deepseek" },
      trustedWorkspaces: [secondTrustedRoot],
      context: { maxTokens: 10_000 },
      permissions: {
        defaultDecision: "deny",
        rules: [{ id: "managed-network", action: "deny", sideEffects: ["network"] }],
      },
    });
    await json(paths.user, {
      trustedWorkspaces: [root],
      models: { openai: "user-openai" },
      turn: { maxSteps: 8 },
      permissions: { rules: [{ id: "user-shell", action: "ask", tools: ["run_shell"] }] },
    });
    await json(paths.project, {
      provider: "deepseek",
      context: { maxTokens: 20_000 },
      permissions: { rules: [{ id: "project-read", action: "allow", tools: ["read_file"] }] },
    });
    await json(paths.local, {
      models: { deepseek: "local-deepseek" },
      turn: { maxDurationMs: 12_000 },
      permissions: { defaultDecision: "ask" },
    });

    const configuration = await loadConfiguration({
      workspaceRoot: root,
      environment: {},
      paths,
    });

    expect(configuration.trust.trusted).toBe(true);
    expect(configuration.loadedFiles.map(({ layer }) => layer))
      .toEqual(["managed", "user", "project", "local"]);
    expect(configuration.provider).toBe("deepseek");
    expect(configuration.models).toEqual({
      openai: "user-openai",
      deepseek: "local-deepseek",
    });
    expect(configuration.context.maxTokens).toBe(20_000);
    expect(configuration.turn).toEqual({ maxSteps: 8, maxDurationMs: 12_000 });
    expect(configuration.trustedWorkspaces).toEqual(expect.arrayContaining([
      await realpath(root),
      await realpath(secondTrustedRoot),
    ]));
    expect(configuration.permissions).toMatchObject({
      defaultDecision: "ask",
      managedRules: [{ id: "managed-network", action: "deny" }],
      userRules: [{ id: "user-shell", action: "ask" }],
      projectRules: [{ id: "project-read", action: "allow" }],
    });
  });

  it("does not read project or local configuration before the workspace is trusted", async () => {
    const { root, paths } = await fixture();
    await json(paths.user, { provider: "openai" });
    await writeFile(paths.project, "not json", "utf8");
    await json(paths.local, { trustedWorkspaces: [root], provider: "deepseek" });

    const configuration = await loadConfiguration({
      workspaceRoot: root,
      environment: {},
      paths,
    });

    expect(configuration.trust.trusted).toBe(false);
    expect(configuration.provider).toBe("openai");
    expect(configuration.loadedFiles.map(({ layer }) => layer)).toEqual(["user"]);
    expect(configuration.skippedFiles).toHaveLength(2);
    expect(configuration.skippedFiles[0]?.reason).toContain("until the workspace is trusted");
  });

  it("rejects project attempts to establish their own trust", async () => {
    const { root, paths } = await fixture();
    await json(paths.user, { trustedWorkspaces: [root] });
    await json(paths.project, { trustedWorkspaces: [root] });

    await expect(loadConfiguration({ workspaceRoot: root, environment: {}, paths }))
      .rejects.toThrow("only managed and user configuration may set this global field");
  });

  it("keeps external path controls in managed and user configuration", async () => {
    const { root, paths } = await fixture();
    await json(paths.user, { trustedWorkspaces: [root] });
    await json(paths.project, { sessionDirectory: "../outside-sessions" });

    await expect(loadConfiguration({ workspaceRoot: root, environment: {}, paths }))
      .rejects.toMatchObject({
        field: "sessionDirectory",
        message: expect.stringContaining("global field"),
      });
  });

  it("reports the exact file, field, and reason for JSON and schema errors", async () => {
    const malformed = await fixture();
    await writeFile(malformed.paths.user, "{", "utf8");
    await expect(loadConfiguration({
      workspaceRoot: malformed.root,
      environment: {},
      paths: malformed.paths,
    })).rejects.toMatchObject({
      name: "ConfigurationError",
      source: malformed.paths.user,
      field: "$",
      message: expect.stringContaining("invalid JSON"),
    });

    const invalid = await fixture();
    await json(invalid.paths.user, { context: { maxTokens: -1 } });
    await expect(loadConfiguration({
      workspaceRoot: invalid.root,
      environment: {},
      paths: invalid.paths,
    })).rejects.toMatchObject({
      name: "ConfigurationError",
      source: invalid.paths.user,
      field: "context.maxTokens",
      message: expect.stringContaining(">0"),
    });

    const invalidRule = await fixture();
    await json(invalidRule.paths.user, {
      permissions: {
        rules: [{ id: "bad-pattern", action: "deny", resources: ["network:*:extra"] }],
      },
    });
    await expect(loadConfiguration({
      workspaceRoot: invalidRule.root,
      environment: {},
      paths: invalidRule.paths,
    })).rejects.toMatchObject({
      source: invalidRule.paths.user,
      field: "permissions.rules[0].resources[0]",
      message: expect.stringContaining("final character"),
    });

    const badTrust = await fixture();
    await json(badTrust.paths.user, { trustedWorkspaces: [join(badTrust.root, "missing")] });
    await expect(loadConfiguration({
      workspaceRoot: badTrust.root,
      environment: {},
      paths: badTrust.paths,
    })).rejects.toMatchObject({
      source: await realpath(badTrust.paths.user),
      field: "trustedWorkspaces[0]",
      message: expect.stringContaining("existing directory"),
    });
  });

  it("rejects a trusted project config symlink that escapes the workspace", async () => {
    const { root, paths } = await fixture();
    const outside = join(await mkdtemp(join(tmpdir(), "agent-code-config-outside-")), "config.json");
    await json(paths.user, { trustedWorkspaces: [root] });
    await json(outside, { provider: "deepseek" });
    await symlink(outside, paths.project);

    await expect(loadConfiguration({ workspaceRoot: root, environment: {}, paths }))
      .rejects.toThrow("resolves outside the trusted workspace");
  });

  it("uses only product-prefixed runtime overrides and validates their values", async () => {
    const { root, paths } = await fixture();
    await json(paths.user, {
      provider: "openai",
      models: { openai: "from-file" },
      context: { maxTokens: 10_000 },
    });
    const configuration = await loadConfiguration({
      workspaceRoot: root,
      cwd: root,
      environment: {
        PROVIDER: "ignored",
        MODEL: "ignored",
        AGENT_CODE_PROVIDER: "deepseek",
        AGENT_CODE_MODEL: "deepseek-env",
        AGENT_CODE_CONTEXT_TOKENS: "24000",
        AGENT_CODE_SESSION_DIR: "state",
      },
      paths,
    });

    expect(configuration.provider).toBe("deepseek");
    expect(configuration.model).toBe("deepseek-env");
    expect(configuration.context.maxTokens).toBe(24_000);
    expect(configuration.sessionDirectory).toBe(join(root, "state"));
    await expect(loadConfiguration({
      workspaceRoot: root,
      environment: { AGENT_CODE_CONTEXT_TOKENS: "many" },
      paths,
    })).rejects.toEqual(expect.objectContaining<Partial<ConfigurationError>>({
      source: "environment",
      field: "AGENT_CODE_CONTEXT_TOKENS",
    }));
  });

  it("keeps managed deny effective when project and local rules allow the same request", async () => {
    const { root, paths } = await fixture();
    await json(paths.managed, {
      permissions: {
        rules: [{ id: "managed-stop", action: "deny", tools: ["run_shell"] }],
      },
    });
    await json(paths.user, { trustedWorkspaces: [root] });
    await json(paths.project, {
      permissions: {
        rules: [{ id: "project-go", action: "allow", tools: ["run_shell"] }],
      },
    });
    const configuration = await loadConfiguration({ workspaceRoot: root, environment: {}, paths });
    const permissions = new PermissionEngine({
      trust: configuration.trust,
      managedRules: configuration.permissions.managedRules,
      userRules: configuration.permissions.userRules,
      projectRules: configuration.permissions.projectRules,
      defaultDecision: configuration.permissions.defaultDecision,
    });

    await expect(permissions.authorize({
      toolName: "run_shell",
      input: { command: "echo safe" },
      sideEffects: ["execute_process"],
    }, new AbortController().signal)).resolves.toMatchObject({
      kind: "deny",
      reason: expect.stringContaining("managed-stop"),
    });
  });

  it("uses the configured session directory for session subcommands", async () => {
    const { root, paths } = await fixture();
    const sessionDirectory = join(root, "configured-sessions");
    await json(paths.user, { sessionDirectory });
    const handle = await new SessionStore({ rootDirectory: sessionDirectory }).create({
      sessionId: "configured-session",
      projectPath: root,
      provider: "openai",
      model: "test-model",
    });
    await handle.close();
    const stdout: string[] = [];

    const result = await runSessionCli(
      ["export", "configured-session"],
      { AGENT_CODE_USER_CONFIG: paths.user },
      {
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
      root,
    );

    expect(result).toBe(0);
    expect(stdout.join("")).toContain("configured-session");
    expect(stdout.join("")).toContain("test-model");
  });
});
