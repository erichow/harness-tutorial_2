import { describe, expect, it } from "vitest";

import { checkNodeVersion, main, type CliIO } from "../../src/cli/main.js";
import { parseChatArgs } from "../../src/cli/chat.js";

function memoryIO(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
    stdout,
    stderr,
  };
}

describe("Node.js version guard", () => {
  it("accepts Node.js 22 and newer", () => {
    expect(checkNodeVersion("22.0.0")).toBeUndefined();
    expect(checkNodeVersion("24.1.0")).toBeUndefined();
  });

  it("returns a readable error for unsupported versions", () => {
    expect(checkNodeVersion("20.19.0")).toContain("requires Node.js 22 or newer");
    expect(checkNodeVersion("not-a-version")).toContain("current version is not-a-version");
  });
});

describe("CLI argument contract", () => {
  it("prints help and returns zero", () => {
    const output = memoryIO();
    const exitCode = main(["--help"], output.io, { nodeVersion: "22.0.0" });

    expect(exitCode).toBe(0);
    expect(output.stdout.join("")).toContain("Usage:");
    expect(output.stderr).toEqual([]);
  });

  it("rejects unknown arguments", () => {
    const output = memoryIO();
    const exitCode = main(["--unknown"], output.io, { nodeVersion: "22.0.0" });

    expect(exitCode).toBe(2);
    expect(output.stderr.join("")).toContain("Unknown argument: --unknown");
  });

  it("checks Node.js before parsing arguments", () => {
    const output = memoryIO();
    const exitCode = main(["--help"], output.io, { nodeVersion: "20.0.0" });

    expect(exitCode).toBe(1);
    expect(output.stderr.join("")).toContain("Node.js 22");
  });
});

describe("chat arguments", () => {
  it("selects OpenAI or DeepSeek without reading a dotenv file", () => {
    expect(parseChatArgs(
      ["--provider", "openai", "--workspace", "project"],
      { OPENAI_MODEL: "gpt-test" },
      "/tmp",
    )).toEqual({
      provider: "openai",
      model: "gpt-test",
      workspace: "/tmp/project",
    });
    expect(parseChatArgs(
      ["--provider", "deepseek", "--model", "deepseek-test"],
      {},
      "/workspace",
    )).toMatchObject({ provider: "deepseek", model: "deepseek-test" });
  });

  it("rejects incomplete provider configuration", () => {
    expect(() => parseChatArgs([], {}, "/workspace")).toThrow("requires --provider");
    expect(() => parseChatArgs(["--provider", "openai"], {}, "/workspace"))
      .toThrow("requires --model");
  });
});
