import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { createTestLoopExecutor } from "../../src/runtime/test-loop.js";
import { resolveTurnLimits } from "../../src/runtime/limits.js";
import type { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ProcessManager } from "../../src/tools/shell/process-manager.js";
import { createTestTools } from "../../src/tools/testing/index.js";
import type { Tool } from "../../src/tools/tool.js";

const managers: ProcessManager[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => await manager.dispose()));
});

function call(id: string, name: string, input: JsonObject = {}) {
  return { type: "tool_call" as const, id, name, input };
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function testExecutor(): Promise<ToolExecutor> {
  const root = await mkdtemp(join(tmpdir(), "dugsyn-tests-"));
  const manager = await ProcessManager.create({
    workspaceRoot: root,
    terminationGraceMs: 20,
  });
  managers.push(manager);
  return new ToolRegistry(createTestTools(manager)).createExecutor();
}

describe("run_tests", () => {
  it("derives pass/fail from exit status and keeps stdout and stderr separate", async () => {
    const executor = await testExecutor();
    const passed = await executor.execute(call("pass", "run_tests", {
      command: nodeCommand('process.stdout.write("ok-out"); process.stderr.write("ok-err")'),
    }), { signal });
    const failed = await executor.execute(call("fail", "run_tests", {
      command: nodeCommand('process.stderr.write("assertion failed"); process.exit(7)'),
    }), { signal });

    expect(passed).toMatchObject({
      status: "success",
      data: {
        testStatus: "passed",
        outcome: "passed",
        exitReason: "exit",
        exitCode: 0,
        stdout: { empty: false },
        stderr: { empty: false },
      },
    });
    expect(passed.content).toContain("stdout:\n[stdout]\nok-out");
    expect(passed.content).toContain("stderr:\n[stderr]\nok-err");
    expect(failed).toMatchObject({
      status: "success",
      data: { testStatus: "failed", outcome: "failed", exitCode: 7 },
    });
    expect(failed.content).toContain("assertion failed");
  });

  it("reports timeout as a failed test outcome instead of a passing command", async () => {
    const executor = await testExecutor();
    const result = await executor.execute(call("timeout", "run_tests", {
      command: nodeCommand("setInterval(() => {}, 1000)"),
      timeoutMs: 30,
    }), { signal });

    expect(result).toMatchObject({
      status: "success",
      data: { testStatus: "failed", outcome: "timed_out", exitReason: "timeout" },
    });
  });
});

describe("test/repair turn policy", () => {
  const tools: readonly Tool[] = [
    {
      definition: {
        name: "run_tests",
        description: "Return a scripted structured test outcome",
        inputSchema: {
          type: "object",
          properties: { outcome: { type: "string" } },
          required: ["outcome"],
          additionalProperties: false,
        },
      },
      sideEffects: ["execute_process"],
      async handler(input) {
        const outcome = String(input.outcome);
        return { content: outcome, data: { outcome, testStatus: outcome === "passed" ? "passed" : "failed" } };
      },
    },
    {
      definition: {
        name: "apply_patch",
        description: "Apply a scripted patch",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      sideEffects: ["write_workspace"],
      async handler() { return { content: "patched" }; },
    },
  ];

  it("counts one repair round across multiple patches and blocks the next round", async () => {
    const loop = createTestLoopExecutor(
      new ToolRegistry(tools).createExecutor(),
      resolveTurnLimits({ maxSteps: 20, maxRepairRounds: 1, maxTestRuns: 3 }),
    );

    await loop.executor.execute(call("test-1", "run_tests", { outcome: "failed" }), { signal });
    const firstPatch = await loop.executor.execute(call("patch-1", "apply_patch"), { signal });
    const sameRoundPatch = await loop.executor.execute(call("patch-2", "apply_patch"), { signal });
    await loop.executor.execute(call("test-2", "run_tests", { outcome: "failed" }), { signal });
    const blocked = await loop.executor.execute(call("patch-3", "apply_patch"), { signal });

    expect(firstPatch.status).toBe("success");
    expect(sameRoundPatch.status).toBe("success");
    expect(blocked).toMatchObject({ status: "error", error: { code: "limit_reached" } });
    expect(loop.summary()).toEqual({
      status: "failed",
      runs: 2,
      repairRounds: 1,
      lastOutcome: "failed",
    });
  });

  it("blocks test attempts beyond the turn-local maximum", async () => {
    const loop = createTestLoopExecutor(
      new ToolRegistry(tools).createExecutor(),
      resolveTurnLimits({ maxSteps: 20, maxTestRuns: 1 }),
    );
    await loop.executor.execute(call("test-1", "run_tests", { outcome: "passed" }), { signal });
    const blocked = await loop.executor.execute(call("test-2", "run_tests", { outcome: "failed" }), { signal });

    expect(blocked).toMatchObject({ status: "error", error: { code: "limit_reached" } });
    expect(loop.summary()).toMatchObject({ status: "passed", runs: 1 });
  });

  it("invalidates a passing verdict when a later patch has not been tested", async () => {
    const loop = createTestLoopExecutor(
      new ToolRegistry(tools).createExecutor(),
      resolveTurnLimits({ maxSteps: 20 }),
    );
    await loop.executor.execute(call("test", "run_tests", { outcome: "passed" }), { signal });
    await loop.executor.execute(call("later-edit", "apply_patch"), { signal });

    expect(loop.summary()).toEqual({
      status: "not_run",
      runs: 1,
      repairRounds: 0,
      lastOutcome: "passed",
    });
  });
});
