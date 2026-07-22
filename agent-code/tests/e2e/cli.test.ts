import { spawnSync } from "node:child_process";
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
    const result = runCli(
      ["chat", "--provider", "openai", "--model", "offline-test"],
      {
        input: "/help\n/status\n/exit\n",
        env: { ...process.env, OPENAI_API_KEY: "not-used" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("/help /status /permissions /clear /exit");
    expect(result.stdout).toContain("Provider: openai (offline-test)");
    expect(result.stdout).not.toMatch(/[\u001b\u0007\r]/u);
  });
});
