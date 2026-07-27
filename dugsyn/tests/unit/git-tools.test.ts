import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { createWorkspaceFileToolset } from "../../src/tools/files/index.js";
import { sha256 } from "../../src/tools/files/text.js";
import { createGitTools } from "../../src/tools/git/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;

describe("structured Git tools", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "dugsyn-git-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "Agent Test");
    await git("config", "user.email", "agent@example.test");
    await writeFile(join(workspace, "agent.txt"), "before\n");
    await writeFile(join(workspace, "user.txt"), "user base\n");
    await git("add", "--", "agent.txt", "user.txt");
    await git("commit", "-m", "initial");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<string> {
    const result = await execFileAsync("git", ["-C", workspace, ...args], { encoding: "utf8" });
    return result.stdout;
  }

  async function fixture() {
    const files = await createWorkspaceFileToolset({ workspaceRoot: workspace });
    const gitTools = await createGitTools({ workspaceRoot: workspace, checkpoints: files.checkpoints });
    const executor = new ToolRegistry([...files.tools, ...gitTools]).createExecutor();
    let call = 0;
    return {
      checkpoints: files.checkpoints,
      execute: async (name: string, input: JsonObject = {}) => await executor.execute({
        type: "tool_call",
        id: `git-${call += 1}`,
        name,
        input,
      }, { signal }),
    };
  }

  async function agentEdit(item: Awaited<ReturnType<typeof fixture>>): Promise<void> {
    const result = await item.execute("apply_patch", {
      baseHash: sha256(await readFile(join(workspace, "agent.txt"))),
      patch: [
        "*** Begin Patch",
        "*** Update File: agent.txt",
        "@@ -1,1 +1,1 @@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    });
    expect(result.status).toBe("success");
  }

  it("returns structured status, diff, and bounded log records", async () => {
    await writeFile(join(workspace, "agent.txt"), "changed outside\n");
    await writeFile(join(workspace, "new.txt"), "new\n");
    const item = await fixture();

    const status = await item.execute("git_status");
    expect(status.status).toBe("success");
    expect(status.data).toMatchObject({
      clean: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "agent.txt", index: " ", worktree: "M" }),
        expect.objectContaining({ path: "new.txt", kind: "untracked" }),
      ]),
    });

    const diff = await item.execute("git_diff", { mode: "worktree", paths: ["agent.txt"] });
    expect(diff.status).toBe("success");
    expect(diff.content).toContain("+changed outside");
    expect(diff.data).toMatchObject({
      mode: "worktree",
      paths: ["agent.txt"],
      empty: false,
      files: [{ status: "M", path: "agent.txt" }],
    });

    const log = await item.execute("git_log", { limit: 1 });
    expect(log.status).toBe("success");
    expect(log.data).toMatchObject({
      commits: [expect.objectContaining({ author: "Agent Test", subject: "initial" })],
    });
  });

  it("keeps both paths in NUL-delimited rename records", async () => {
    await git("mv", "agent.txt", "renamed.txt");
    const item = await fixture();

    const status = await item.execute("git_status");
    expect(status.data).toMatchObject({
      entries: [expect.objectContaining({
        path: "renamed.txt",
        originalPath: "agent.txt",
        index: "R",
        kind: "renamed",
      })],
    });

    const diff = await item.execute("git_diff", { mode: "staged", paths: [] });
    expect(diff.data).toMatchObject({
      files: [expect.objectContaining({
        status: "R100",
        path: "renamed.txt",
        originalPath: "agent.txt",
      })],
    });
  });

  it("previews through a temporary index and commits only Agent-owned paths", async () => {
    const item = await fixture();
    item.checkpoints.beginTurn();
    await agentEdit(item);
    await writeFile(join(workspace, "user.txt"), "user unstaged\n");
    await writeFile(join(workspace, "user-new.txt"), "user untracked\n");

    const preview = await item.execute("git_prepare_commit", { paths: ["agent.txt"] });
    expect(preview.status).toBe("success");
    expect(preview.content).toContain("real index unchanged");
    expect(preview.content).toContain("+after");
    await expect(git("diff", "--cached", "--name-only")).resolves.toBe("");

    const token = typeof preview.data === "object" && preview.data !== null && !Array.isArray(preview.data)
      ? preview.data.token
      : undefined;
    expect(typeof token).toBe("string");
    const committed = await item.execute("git_commit", { token: token as string, message: "agent change" });
    expect(committed.status).toBe("success");
    await expect(git("show", "--format=", "--name-only", "HEAD")).resolves.toBe("agent.txt\n");
    await expect(readFile(join(workspace, "user.txt"), "utf8")).resolves.toBe("user unstaged\n");
    await expect(readFile(join(workspace, "user-new.txt"), "utf8")).resolves.toBe("user untracked\n");
    await expect(git("status", "--short")).resolves.toContain(" M user.txt");
  });

  it("refuses to overwrite a user's existing staged state", async () => {
    await writeFile(join(workspace, "user.txt"), "user staged\n");
    await git("add", "--", "user.txt");
    const item = await fixture();
    item.checkpoints.beginTurn();
    await agentEdit(item);

    const result = await item.execute("git_prepare_commit", { paths: ["agent.txt"] });

    expect(result.status).toBe("error");
    expect(result.content).toContain("user already has staged changes");
    await expect(git("diff", "--cached", "--name-only")).resolves.toBe("user.txt\n");
  });

  it("rejects non-owned paths and detects edits made after preview", async () => {
    const item = await fixture();
    item.checkpoints.beginTurn();
    await agentEdit(item);
    const nonOwned = await item.execute("git_prepare_commit", { paths: ["user.txt"] });
    expect(nonOwned.status).toBe("error");
    expect(nonOwned.content).toContain("not owned");

    const preview = await item.execute("git_prepare_commit", { paths: ["agent.txt"] });
    expect(preview.status).toBe("success");
    const token = typeof preview.data === "object" && preview.data !== null && !Array.isArray(preview.data)
      ? preview.data.token
      : undefined;
    await writeFile(join(workspace, "agent.txt"), "user after preview\n");

    const commit = await item.execute("git_commit", { token: token as string, message: "must fail" });
    expect(commit.status).toBe("error");
    expect(commit.content).toContain("no longer matches");
    await expect(git("rev-list", "--count", "HEAD")).resolves.toBe("1\n");
    await expect(git("diff", "--cached", "--name-only")).resolves.toBe("");
  });
});
