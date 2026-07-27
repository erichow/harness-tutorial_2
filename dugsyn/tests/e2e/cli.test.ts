import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../../dist/cli/bin.js", import.meta.url));

function runCli(args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

describe("built CLI", () => {
  it("prints help with exit code zero", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("prints help from subcommands with exit code zero", () => {
    for (const args of [["chat", "--help"], ["session", "--help"]]) {
      const result = runCli(args);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).toBe("");
    }
  });

  it("returns a non-zero exit code for an unknown argument", () => {
    const result = runCli(["--unknown"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown argument");
  });

  it("classifies interactive argument and credential failures as usage errors", () => {
    const missingValue = runCli(["chat", "--provider"]);
    expect(missingValue.status).toBe(2);
    expect(missingValue.stderr).toContain("Input error: --provider requires a value");
    expect(missingValue.stderr).not.toContain("Internal error");

    const missingKey = runCli([
      "chat",
      "--provider", "openai",
      "--model", "offline-test",
    ], {
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
    expect(missingKey.status).toBe(2);
    expect(missingKey.stderr).toContain("Input error: OPENAI_API_KEY is required");
    expect(missingKey.stderr).not.toContain("Internal error");

    const missingSessionDirectory = runCli([
      "session", "export", "missing-session", "--session-dir",
    ]);
    expect(missingSessionDirectory.status).toBe(2);
    expect(missingSessionDirectory.stderr)
      .toContain("Input error: --session-dir requires a value");
  });

  it("routes piped JSONL input through headless mode without protocol noise", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "dugsyn-e2e-headless-"));
    try {
      const result = runCli(
        [
          "--print",
          "--input-format", "jsonl",
          "--output-format", "jsonl",
          "--provider", "openai",
          "--model", "offline-test",
          "--session-dir", sessionDirectory,
        ],
        {
          input: '{"protocolVersion":1,"type":"request","prompt":\n',
          env: {
            ...process.env,
            OPENAI_API_KEY: "not-used",
            DUGSYN_USER_CONFIG: join(sessionDirectory, "missing-config.json"),
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("JSONL line 1 is not valid JSON");
    } finally {
      rmSync(sessionDirectory, { recursive: true, force: true });
    }
  });

  it("runs slash commands in a non-TTY chat without contacting the provider", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "dugsyn-e2e-session-"));
    const result = runCli(
      [
        "chat",
        "--provider", "openai",
        "--model", "offline-test",
        "--session-dir", sessionDirectory,
      ],
      {
        input: "/help\n/status\n/context\n/exit\n",
        env: { ...process.env, OPENAI_API_KEY: "not-used" },
      },
    );
    rmSync(sessionDirectory, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("/help /status /context /permissions /undo /clear /exit");
    expect(result.stdout).toContain("Provider: openai (offline-test)");
    expect(result.stdout).toContain("Context: ~");
    expect(result.stdout).toContain("Created session");
    expect(result.stdout).not.toMatch(/[\u001b\u0007\r]/u);
  });

  it("resumes, forks, and exports a durable session without contacting the provider", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "dugsyn-e2e-resume-"));
    try {
      const created = runCli(
        [
          "chat",
          "--provider", "openai",
          "--model", "offline-test",
          "--session-name", "E2E session",
          "--session-dir", sessionDirectory,
        ],
        {
          input: "/exit\n",
          env: { ...process.env, OPENAI_API_KEY: "not-used" },
        },
      );
      expect(created.status).toBe(0);
      const sessionId = /Created session ([a-zA-Z0-9._-]+)\./u.exec(created.stdout)?.[1];
      expect(sessionId).toBeDefined();

      const resumed = runCli(
        ["--resume", sessionId as string, "--session-dir", sessionDirectory],
        {
          input: "/status\n/exit\n",
          env: { ...process.env, OPENAI_API_KEY: "not-used" },
        },
      );
      expect(resumed.status).toBe(0);
      expect(resumed.stdout).toContain(`Resumed session ${sessionId}`);
      expect(resumed.stdout).toContain("Session: E2E session");

      const forked = runCli(
        ["--fork-session", sessionId as string, "--session-dir", sessionDirectory],
        {
          input: "/exit\n",
          env: { ...process.env, OPENAI_API_KEY: "not-used" },
        },
      );
      expect(forked.status).toBe(0);
      expect(forked.stdout).toContain("Forked session");

      const exported = runCli([
        "session", "export", sessionId as string, "--session-dir", sessionDirectory,
      ]);
      expect(exported.status).toBe(0);
      expect(exported.stdout).toContain("# E2E session");
      expect(exported.stdout).toContain(`Session: \`${sessionId}\``);
    } finally {
      rmSync(sessionDirectory, { recursive: true, force: true });
    }
  });

  it("treats symlinked and canonical workspace paths as the same session workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "dugsyn-e2e-workspace-alias-"));
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    const sessionDirectory = join(root, "sessions");
    mkdirSync(workspace);
    symlinkSync(workspace, alias, "dir");
    const canonicalWorkspace = realpathSync(workspace);

    try {
      const created = runCli(
        [
          "chat",
          "--provider", "openai",
          "--model", "offline-test",
          "--workspace", alias,
          "--session-dir", sessionDirectory,
        ],
        {
          input: "/exit\n",
          env: { ...process.env, OPENAI_API_KEY: "not-used" },
        },
      );
      expect(created.status).toBe(0);
      const sessionId = /Created session ([a-zA-Z0-9._-]+)\./u.exec(created.stdout)?.[1];
      expect(sessionId).toBeDefined();

      const resumed = runCli(
        [
          "--resume", sessionId as string,
          "--workspace", workspace,
          "--session-dir", sessionDirectory,
        ],
        {
          input: "/status\n/exit\n",
          env: { ...process.env, OPENAI_API_KEY: "not-used" },
        },
      );
      expect(resumed.status).toBe(0);
      expect(resumed.stderr).toBe("");

      const exported = runCli([
        "session", "export", sessionId as string, "--session-dir", sessionDirectory,
      ]);
      expect(exported.status).toBe(0);
      expect(exported.stdout).toContain(`Project: \`${canonicalWorkspace}\``);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
