import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTranscript } from "../../src/messages/transcript.js";
import type { JsonObject } from "../../src/protocol/json.js";
import type { ProviderRequest } from "../../src/providers/provider.js";
import {
  MockProvider,
  type MockProviderResponse,
} from "../../src/providers/mock.js";
import { CodingAgentRuntime } from "../../src/runtime/coding-agent.js";
import { PermissionEngine } from "../../src/security/permissions.js";
import { WorkspaceTrust } from "../../src/security/trust.js";
import { sha256 } from "../../src/tools/files/text.js";
import { HostSandboxRunner } from "../../src/tools/shell/sandbox-runner.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(
    async (workspace) => await rm(workspace, { recursive: true, force: true }),
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

async function fixture(): Promise<{ root: string; original: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-code-mvp-"));
  workspaces.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  const original = "export const config = { timeout: 5000 };\n";
  await writeFile(join(root, "src/config.js"), original);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "test/config.test.js"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { config } from "../src/config.js";',
    'test("timeout is 10000", () => assert.equal(config.timeout, 10000));',
    "",
  ].join("\n"));
  return { root, original };
}

function userTranscript(text: string) {
  return createTranscript([{
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2026-07-23T00:00:00.000Z",
  }]);
}

function shellExitCode(request: ProviderRequest): number | undefined {
  const message = request.transcript.messages.at(-1);
  const result = message?.content.find((block) => block.type === "tool_result");
  if (result?.type !== "tool_result") return undefined;
  const data = result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return typeof data.exitCode === "number" ? data.exitCode : undefined;
}

describe("MVP end-to-end acceptance", () => {
  it("searches, reads, patches with a hash, runs tests, and logs the real outcome", async () => {
    const { root, original } = await fixture();
    const baseHash = sha256(Buffer.from(original));
    const prompts: string[] = [];
    const trust = await WorkspaceTrust.create({ workspaceRoot: root, trustedRoots: [root] });
    const permissions = new PermissionEngine({
      trust,
      userRules: [{
        id: "allow-read-only-discovery",
        action: "allow",
        tools: ["search_text", "read_file"],
        reason: "Read-only project discovery is pre-approved for this test.",
      }],
      decide: async (request) => {
        prompts.push(request.toolName);
        return "allow_once";
      },
    });
    const testCommand = `${JSON.stringify(process.execPath)} --test test/config.test.js`;
    const provider = new MockProvider([
      toolCall("search-1", "search_text", { query: "timeout", path: "." }),
      toolCall("read-1", "read_file", { path: "src/config.js" }),
      toolCall("patch-1", "apply_patch", {
        baseHash,
        patch: [
          "*** Begin Patch",
          "*** Update File: src/config.js",
          "@@ -1,1 +1,1 @@",
          "-export const config = { timeout: 5000 };",
          "+export const config = { timeout: 10000 };",
          "*** End Patch",
        ].join("\n"),
      }),
      toolCall("test-1", "run_shell", {
        command: testCommand,
        timeoutMs: 10_000,
      }),
      (request) => {
        const exitCode = shellExitCode(request);
        return response(
          {
            type: "text_delta",
            delta: exitCode === 0
              ? "Updated timeout from 5000 to 10000. Tests passed with exit code 0."
              : `Updated timeout, but tests failed with exit code ${String(exitCode)}.`,
          },
          { type: "response_completed", finishReason: "stop" },
        );
      },
    ]);
    const runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot: root,
      permissions,
      shell: { runner: new HostSandboxRunner(), terminationGraceMs: 20 },
    });

    try {
      const result = await runtime.runTurn({
        transcript: userTranscript("把 timeout 从 5000 改为 10000，并运行测试。"),
      });

      expect(result.reason).toBe("completed");
      expect(result.steps).toBe(5);
      expect(await readFile(join(root, "src/config.js"), "utf8"))
        .toBe("export const config = { timeout: 10000 };\n");
      expect(prompts).toEqual(["apply_patch", "run_shell"]);

      const started = runtime.eventLog.entries.filter(
        (event) => event.type === "tool_call_started",
      );
      expect(started.map((event) => event.call.name)).toEqual([
        "search_text",
        "read_file",
        "apply_patch",
        "run_shell",
      ]);
      expect(runtime.eventLog.permissionDecisions.map((event) => event.toolName))
        .toEqual(["search_text", "read_file", "apply_patch", "run_shell"]);
      expect(runtime.eventLog.entries.filter((event) => event.type === "permission_requested")
        .map((event) => event.toolName)).toEqual(["apply_patch", "run_shell"]);
      expect(runtime.eventLog.fileChanges).toEqual([
        expect.objectContaining({
          toolCallId: "patch-1",
          operation: "update",
          path: "src/config.js",
          beforeHash: baseHash,
          afterHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        }),
      ]);

      const shellResult = runtime.eventLog.entries.find(
        (event) => event.type === "tool_call_finished" && event.result.toolCallId === "test-1",
      );
      expect(shellResult).toMatchObject({
        type: "tool_call_finished",
        result: { status: "success", data: { exitCode: 0, exitReason: "exit" } },
      });
      expect(result.transcript.messages.at(-1)?.content).toEqual([
        { type: "text", text: "Updated timeout from 5000 to 10000. Tests passed with exit code 0." },
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "keeps a failed patch intact and disposes a child process after a provider failure",
    async () => {
      const { root, original } = await fixture();
      const trust = await WorkspaceTrust.create({ workspaceRoot: root, trustedRoots: [root] });
      const permissions = new PermissionEngine({ trust, defaultDecision: "allow" });
      const provider = new MockProvider([
        toolCall("bad-patch", "apply_patch", {
          baseHash: sha256(Buffer.from(original)),
          patch: [
            "*** Begin Patch",
            "*** Update File: src/config.js",
            "@@ -1,1 +1,1 @@",
            "-this context does not exist",
            "+export const config = { timeout: 10000 };",
            "*** End Patch",
          ].join("\n"),
        }),
        toolCall("job-1", "start_job", {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
          timeoutMs: 30_000,
        }),
        response({ type: "text_delta", delta: "provider stream breaks before completion" }),
      ]);
      const runtime = await CodingAgentRuntime.create({
        provider,
        workspaceRoot: root,
        permissions,
        shell: { runner: new HostSandboxRunner(), terminationGraceMs: 20 },
      });
      let childPid: number | undefined;

      try {
        const result = await runtime.runTurn({ transcript: userTranscript("run the failure case") });
        expect(result.reason).toBe("error");
        const jobEvent = runtime.eventLog.entries.find(
          (event) => event.type === "tool_call_finished" && event.result.toolCallId === "job-1",
        );
        if (jobEvent?.type === "tool_call_finished") {
          const data = jobEvent.result.data;
          if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            childPid = typeof data.pid === "number" ? data.pid : undefined;
          }
        }
        expect(childPid).toBeTypeOf("number");
        expect(isProcessAlive(childPid)).toBe(true);
        expect(await readFile(join(root, "src/config.js"), "utf8")).toBe(original);
        expect((await readdir(join(root, "src"))).some((name) => name.includes(".agent-code-")))
          .toBe(false);
        expect(runtime.eventLog.fileChanges).toEqual([]);
      } finally {
        await runtime.dispose();
      }

      await expectProcessToExit(childPid);
    },
    10_000,
  );
});

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessToExit(pid: number | undefined): Promise<void> {
  for (let attempt = 0; attempt < 50 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isProcessAlive(pid)).toBe(false);
}
