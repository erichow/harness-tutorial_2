import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvalRunner } from "../../src/evals/runner.js";
import type { JsonObject } from "../../src/protocol/json.js";
import { MockProvider, type MockProviderResponse } from "../../src/providers/mock.js";
import { sha256 } from "../../src/tools/files/text.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

function response(...events: MockProviderResponse["events"]): MockProviderResponse {
  return { events };
}

function toolCall(id: string, name: string, input: JsonObject): MockProviderResponse {
  return response(
    { type: "tool_call", call: { type: "tool_call", id, name, input } },
    { type: "response_completed", finishReason: "tool_calls" },
  );
}

function files(): Readonly<Record<string, string>> {
  return {
    "package.json": JSON.stringify({ type: "module" }),
    "src/answer.js": "export const answer = 1;\n",
    "test/answer.test.js": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { answer } from "../src/answer.js";',
      'test("answer is fixed", () => assert.equal(answer, 2));',
      "",
    ].join("\n"),
  };
}

describe("EvalRunner", () => {
  it("runs the concrete Agent in fresh repositories and reports repeat statistics", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dugsyn-eval-test-"));
    temporaryDirectories.push(parent);
    const original = files()["src/answer.js"] ?? "";
    const runner = new EvalRunner({
      name: "repair answer",
      prompt: "把 answer 修复为 2，并运行测试。",
      files: files(),
      expectedChangedFiles: ["src/answer.js"],
      provider: () => new MockProvider([
        toolCall("patch-1", "apply_patch", {
          baseHash: sha256(Buffer.from(original)),
          patch: [
            "*** Begin Patch",
            "*** Update File: src/answer.js",
            "@@ -1,1 +1,1 @@",
            "-export const answer = 1;",
            "+export const answer = 2;",
            "*** End Patch",
          ].join("\n"),
        }),
        toolCall("test-1", "run_tests", {
          command: `${JSON.stringify(process.execPath)} --test test/answer.test.js`,
          timeoutMs: 10_000,
        }),
        response(
          { type: "usage", inputTokens: 20, outputTokens: 8 },
          { type: "text_delta", delta: "修复完成，测试通过。" },
          { type: "response_completed", finishReason: "stop" },
        ),
      ]),
      test: {
        file: process.execPath,
        args: ["--test", "test/answer.test.js"],
        timeoutMs: 10_000,
      },
    }, {
      repeats: 2,
      temporaryDirectory: parent,
      preserveWorkspaces: "never",
    });

    const report = await runner.run();

    expect(report).toMatchObject({
      scenario: "repair answer",
      passed: 8,
      total: 8,
      successRate: 1,
      scoreMean: 1,
      scoreVariance: 0,
    });
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]).toMatchObject({
      success: true,
      passed: 4,
      total: 4,
      test: { passed: true, exitCode: 0 },
      changedFiles: ["src/answer.js"],
    });
    expect(report.runs[0]?.diff).toContain("+export const answer = 2;");
    expect(report.runs[0]?.gitStatus).toEqual([
      expect.objectContaining({ path: "src/answer.js", worktree: "M" }),
    ]);
    expect(report.runs[0]?.trace.spans.map((span) => span.kind)).toEqual(
      expect.arrayContaining(["session", "turn", "provider_request", "tool_call"]),
    );
    expect(report.runs[0]?.trace.totals.usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cachedInputTokens: 0,
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it("scores real test and Git failures with formal passed/total fields", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dugsyn-eval-failure-"));
    temporaryDirectories.push(parent);
    const report = await new EvalRunner({
      name: "no repair",
      prompt: "修复测试。",
      files: files(),
      expectedChangedFiles: ["src/answer.js"],
      provider: () => new MockProvider([
        response(
          { type: "text_delta", delta: "没有修改。" },
          { type: "response_completed", finishReason: "stop" },
        ),
      ]),
      test: {
        file: process.execPath,
        args: ["--test", "test/answer.test.js"],
      },
    }, { temporaryDirectory: parent }).run();

    expect(report).toMatchObject({
      passed: 1,
      total: 4,
      successRate: 0,
      scoreMean: 0.25,
      scoreVariance: 0,
    });
    expect(report.runs[0]).toMatchObject({
      passed: 1,
      total: 4,
      success: false,
      test: { passed: false, exitCode: 1 },
      diff: "",
      gitStatus: [],
      changedFiles: [],
      checks: [
        { name: "agent_completed", passed: true },
        { name: "tests_passed", passed: false },
        { name: "workspace_changed", passed: false },
        { name: "expected_files_changed", passed: false },
      ],
    });
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects fixture and command paths that escape the controlled workspace", async () => {
    expect(() => new EvalRunner({
      name: "unsafe",
      prompt: "unsafe",
      files: { "../outside.txt": "no" },
      provider: () => new MockProvider([]),
      test: { file: process.execPath },
    })).not.toThrow();

    const parent = await mkdtemp(join(tmpdir(), "dugsyn-eval-unsafe-"));
    temporaryDirectories.push(parent);
    await expect(new EvalRunner({
      name: "unsafe",
      prompt: "unsafe",
      files: { "../outside.txt": "no" },
      provider: () => new MockProvider([]),
      test: { file: process.execPath },
    }, { temporaryDirectory: parent }).run()).rejects.toThrow("Unsafe Eval fixture path");
    expect(await readdir(parent)).toEqual([]);
  });
});
