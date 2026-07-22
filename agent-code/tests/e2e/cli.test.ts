import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../../dist/cli/bin.js", import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
  });
}

describe("built CLI", () => {
  it("prints help with exit code zero", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("returns a non-zero exit code for an unknown argument", () => {
    const result = runCli("--unknown");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown argument");
  });
});
