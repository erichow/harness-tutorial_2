import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("returns a non-zero exit code for an unknown argument", () => {
    const result = runCli(["--unknown"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown argument");
  });

  it("runs slash commands in a non-TTY chat without contacting the provider", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "agent-code-e2e-session-"));
    const result = runCli(
      [
        "chat",
        "--provider", "openai",
        "--model", "offline-test",
        "--session-dir", sessionDirectory,
      ],
      {
        input: "/help\n/status\n/exit\n",
        env: { ...process.env, OPENAI_API_KEY: "not-used" },
      },
    );
    rmSync(sessionDirectory, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("/help /status /permissions /undo /clear /exit");
    expect(result.stdout).toContain("Provider: openai (offline-test)");
    expect(result.stdout).toContain("Created session");
    expect(result.stdout).not.toMatch(/[\u001b\u0007\r]/u);
  });

  it("resumes, forks, and exports a durable session without contacting the provider", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "agent-code-e2e-resume-"));
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
});
