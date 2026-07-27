import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { MockProvider, type MockProviderResponse } from "../../src/providers/mock.js";
import {
  SubagentBatch,
  SubagentCoordinator,
  type SubagentProviderContext,
  type SubagentTask,
} from "../../src/subagents/coordinator.js";
import { sha256 } from "../../src/tools/files/text.js";
import { GitAdapter, gitError } from "../../src/tools/git/adapter.js";

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

async function fixture(): Promise<{ root: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), "dugsyn-subagent-test-"));
  temporaryDirectories.push(parent);
  const createdRoot = join(parent, "repository");
  await mkdir(createdRoot);
  const root = await realpath(createdRoot);
  await Promise.all([
    writeFile(join(root, "a.js"), "export const a = 1;\n", "utf8"),
    writeFile(join(root, "b.js"), "export const b = 1;\n", "utf8"),
  ]);
  const git = new GitAdapter(root);
  const signal = new AbortController().signal;
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "dugsyn Test"],
    ["config", "user.email", "test@dugsyn.invalid"],
    ["add", "--all"],
    ["commit", "-m", "fixture"],
  ] as const) {
    const result = await git.run(args, signal);
    if (result.exitCode !== 0) throw gitError(`git ${args[0] ?? ""}`, result);
  }
  return { root, parent };
}

function patchProvider(
  path: "a.js" | "b.js",
  from: number,
  to: number,
  providers?: MockProvider[],
): MockProvider {
  const original = `export const ${path[0]} = ${from};\n`;
  const provider = new MockProvider([
    toolCall(`patch-${path}`, "apply_patch", {
      baseHash: sha256(Buffer.from(original)),
      patch: [
        "*** Begin Patch",
        `*** Update File: ${path}`,
        "@@ -1,1 +1,1 @@",
        `-export const ${path[0]} = ${from};`,
        `+export const ${path[0]} = ${to};`,
        "*** End Patch",
      ].join("\n"),
    }),
    response(
      { type: "text_delta", delta: `${path} 已修改。` },
      { type: "response_completed", finishReason: "stop" },
    ),
  ]);
  providers?.push(provider);
  return provider;
}

function writeTask(id: string, path: string): SubagentTask {
  return {
    id,
    prompt: `只修改 ${path}`,
    mode: "write",
    requestedTools: ["read_file", "apply_patch"],
    writeScopes: [path],
  };
}

describe("SubagentCoordinator", () => {
  it("runs independent tasks in distinct worktrees and integrates validated commits", async () => {
    const { root, parent } = await fixture();
    const contexts: SubagentProviderContext[] = [];
    const providers: MockProvider[] = [];
    const coordinator = new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, "batches"),
      parentGrant: { tools: ["list_files", "read_file", "apply_patch"] },
      provider: (context) => {
        contexts.push(context);
        return context.taskId === "task-a"
          ? patchProvider("a.js", 1, 2, providers)
          : patchProvider("b.js", 1, 3, providers);
      },
    });

    const batch = await coordinator.run([
      writeTask("task-a", "a.js"),
      writeTask("task-b", "b.js"),
    ]);
    try {
      expect(new Set(contexts.map((context) => context.workspaceRoot)).size).toBe(2);
      expect(contexts.every((context) => context.workspaceRoot !== root)).toBe(true);
      expect(batch.results).toHaveLength(2);
      expect(batch.results.every((result) => result.status === "completed")).toBe(true);
      expect(batch.results.map((result) => result.artifact?.changedFiles)).toEqual([
        ["a.js"],
        ["b.js"],
      ]);
      expect(batch.results.every((result) => !("transcript" in result))).toBe(true);
      expect(batch.results.every((result) => result.artifact?.diffSha256.match(/^[a-f0-9]{64}$/u))).toBe(true);
      expect(providers).toHaveLength(2);
      for (const provider of providers) {
        const messages = provider.requests[0]?.transcript.messages ?? [];
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
        expect(messages.some((message) =>
          message.content.some((block) => block.type === "text" && block.text.includes("parent-secret"))
        )).toBe(false);
        expect(provider.requests[0]?.tools.map((tool) => tool.name).sort()).toEqual([
          "apply_patch",
          "read_file",
        ]);
      }

      const integrated = await batch.integrate({
        file: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');if(!fs.readFileSync('a.js','utf8').includes('= 2')||!fs.readFileSync('b.js','utf8').includes('= 3'))process.exit(1)",
        ],
      });

      expect(integrated).toMatchObject({
        status: "merged",
        test: { passed: true, exitCode: 0 },
      });
      await expect(readFile(join(root, "a.js"), "utf8")).resolves.toBe("export const a = 2;\n");
      await expect(readFile(join(root, "b.js"), "utf8")).resolves.toBe("export const b = 3;\n");
      expect(await new GitAdapter(root).status(new AbortController().signal)).toEqual([]);
    } finally {
      await batch.dispose();
    }
  });

  it("rejects child capabilities above the parent grant and overlapping write scopes", async () => {
    const { root, parent } = await fixture();
    const provider = vi.fn(() => new MockProvider([]));
    const coordinator = new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, "batches"),
      parentGrant: { tools: ["read_file", "apply_patch"] },
      provider,
    });

    await expect(coordinator.run([{
      ...writeTask("too-powerful", "a.js"),
      requestedTools: ["read_file", "run_shell"],
    }])).rejects.toThrow("not granted by parent");
    await expect(coordinator.run([
      { ...writeTask("one", "src"), writeScopes: ["src"] },
      { ...writeTask("two", "src/nested"), writeScopes: ["src/nested"] },
    ])).rejects.toThrow("write scopes overlap");
    expect(provider).not.toHaveBeenCalled();
  });

  it("turns an out-of-scope write into a failed structured result", async () => {
    const { root, parent } = await fixture();
    const coordinator = new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, "batches"),
      parentGrant: { tools: ["read_file", "apply_patch"] },
      provider: () => patchProvider("b.js", 1, 9),
    });
    const batch = await coordinator.run([writeTask("bounded", "a.js")]);
    try {
      expect(batch.results[0]).toMatchObject({
        taskId: "bounded",
        mode: "write",
        status: "failed",
        error: {
          code: "scope_violation",
          message: expect.stringContaining("b.js"),
        },
      });
      expect(await batch.integrate({ file: process.execPath, args: ["-e", "process.exit(0)"] }))
        .toMatchObject({ status: "rejected", reason: "subagent_failed" });
      await expect(readFile(join(root, "b.js"), "utf8")).resolves.toBe("export const b = 1;\n");
    } finally {
      await batch.dispose();
    }
  });

  it("keeps the parent unchanged when integration tests fail", async () => {
    const { root, parent } = await fixture();
    const coordinator = new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, "batches"),
      parentGrant: { tools: ["read_file", "apply_patch"] },
      provider: () => patchProvider("a.js", 1, 2),
    });
    const batch = await coordinator.run([writeTask("failing-test", "a.js")]);
    try {
      const result = await batch.integrate({
        file: process.execPath,
        args: ["-e", "process.stderr.write('failed');process.exit(7)"],
      });
      expect(result).toMatchObject({
        status: "rejected",
        reason: "tests_failed",
        test: { passed: false, exitCode: 7, stderr: "failed" },
      });
      await expect(readFile(join(root, "a.js"), "utf8")).resolves.toBe("export const a = 1;\n");
    } finally {
      await batch.dispose();
    }
  });

  it("detects conflicting artifacts inside the integration worktree", async () => {
    const { root, parent } = await fixture();
    const makeCoordinator = (value: number) => new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, `batches-${value}`),
      parentGrant: { tools: ["read_file", "apply_patch"] },
      provider: () => patchProvider("a.js", 1, value),
    });
    const first = await makeCoordinator(2).run([writeTask("first", "a.js")]);
    const second = await makeCoordinator(3).run([writeTask("second", "a.js")]);
    const combinedRoot = await mkdtemp(join(parent, "combined-"));
    const combined = new SubagentBatch({
      repositoryRoot: root,
      batchRoot: combinedRoot,
      baseCommit: first.baseCommit,
      results: [...first.results, ...second.results],
      worktrees: [],
    });
    try {
      const result = await combined.integrate({
        file: process.execPath,
        args: ["-e", "process.exit(0)"],
      });
      expect(result).toMatchObject({ status: "rejected", reason: "conflict" });
      await expect(readFile(join(root, "a.js"), "utf8")).resolves.toBe("export const a = 1;\n");
    } finally {
      await Promise.all([combined.dispose(), first.dispose(), second.dispose()]);
    }
  });

  it("refuses to merge over concurrent parent changes", async () => {
    const { root, parent } = await fixture();
    const coordinator = new SubagentCoordinator({
      repositoryRoot: root,
      temporaryDirectory: join(parent, "batches"),
      parentGrant: { tools: ["read_file", "apply_patch"] },
      provider: () => patchProvider("a.js", 1, 2),
    });
    const batch = await coordinator.run([writeTask("concurrent", "a.js")]);
    try {
      await writeFile(join(root, "user-notes.txt"), "user change\n", "utf8");
      const result = await batch.integrate({
        file: process.execPath,
        args: ["-e", "process.exit(0)"],
      });
      expect(result).toMatchObject({ status: "rejected", reason: "parent_dirty" });
      await expect(readFile(join(root, "a.js"), "utf8")).resolves.toBe("export const a = 1;\n");
      await expect(readFile(join(root, "user-notes.txt"), "utf8")).resolves.toBe("user change\n");
    } finally {
      await batch.dispose();
    }
  });
});
