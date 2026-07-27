import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { createWorkspaceFileToolset } from "../../src/tools/files/index.js";
import { sha256 } from "../../src/tools/files/text.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const signal = new AbortController().signal;

describe("workspace checkpoints", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "dugsyn-checkpoint-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function fixture() {
    const toolset = await createWorkspaceFileToolset({ workspaceRoot: workspace });
    const executor = new ToolRegistry(toolset.tools).createExecutor();
    let call = 0;
    return {
      checkpoints: toolset.checkpoints,
      execute: async (input: JsonObject) => await executor.execute({
        type: "tool_call",
        id: `patch-${call += 1}`,
        name: "apply_patch",
        input,
      }, { signal }),
    };
  }

  it("restores exact update/delete preimages and removes files added by the agent", async () => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("alpha\r\n", "utf8")]);
    await writeFile(join(workspace, "updated.txt"), original);
    await chmod(join(workspace, "updated.txt"), 0o640);
    await writeFile(join(workspace, "deleted.txt"), "keep me\n");
    const item = await fixture();
    const checkpointId = item.checkpoints.beginTurn();
    item.checkpoints.attachTurn(checkpointId, "turn-1");

    expect((await item.execute({
      baseHash: sha256(original),
      patch: [
        "*** Begin Patch",
        "*** Update File: updated.txt",
        "@@ -1,1 +1,1 @@",
        "-alpha",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    expect((await item.execute({
      baseHash: sha256(await readFile(join(workspace, "deleted.txt"))),
      patch: [
        "*** Begin Patch",
        "*** Delete File: deleted.txt",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    expect((await item.execute({
      baseHash: null,
      patch: [
        "*** Begin Patch",
        "*** Add File: added.txt",
        "+temporary",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    item.checkpoints.finishTurn(checkpointId);

    const undone = await item.checkpoints.undoLatest();

    expect(undone).toMatchObject({
      status: "undone",
      turnId: "turn-1",
      paths: ["updated.txt", "deleted.txt", "added.txt"],
    });
    await expect(readFile(join(workspace, "updated.txt"))).resolves.toEqual(original);
    expect((await lstat(join(workspace, "updated.txt"))).mode & 0o777).toBe(0o640);
    await expect(readFile(join(workspace, "deleted.txt"), "utf8")).resolves.toBe("keep me\n");
    await expect(readFile(join(workspace, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await item.checkpoints.undoLatest()).toMatchObject({ status: "nothing_to_undo" });
  });

  it("preflights every file and refuses the whole undo after a user edit", async () => {
    await writeFile(join(workspace, "a.txt"), "a0\n");
    await writeFile(join(workspace, "b.txt"), "b0\n");
    const item = await fixture();
    const checkpointId = item.checkpoints.beginTurn();

    for (const [path, before, after] of [
      ["a.txt", "a0", "a1"],
      ["b.txt", "b0", "b1"],
    ] as const) {
      expect((await item.execute({
        baseHash: sha256(await readFile(join(workspace, path))),
        patch: [
          "*** Begin Patch",
          `*** Update File: ${path}`,
          "@@ -1,1 +1,1 @@",
          `-${before}`,
          `+${after}`,
          "*** End Patch",
        ].join("\n"),
      })).status).toBe("success");
    }
    item.checkpoints.finishTurn(checkpointId);
    await writeFile(join(workspace, "b.txt"), "user edit\n");

    const refused = await item.checkpoints.undoLatest();

    expect(refused).toMatchObject({ status: "conflict", paths: ["a.txt", "b.txt"] });
    expect(refused.status === "conflict" ? refused.message : "").toContain("b.txt");
    await expect(readFile(join(workspace, "a.txt"), "utf8")).resolves.toBe("a1\n");
    await expect(readFile(join(workspace, "b.txt"), "utf8")).resolves.toBe("user edit\n");
  });

  it("detects a user edit between two agent writes to the same path", async () => {
    const path = join(workspace, "shared.txt");
    await writeFile(path, "original\n");
    const item = await fixture();
    const checkpointId = item.checkpoints.beginTurn();

    expect((await item.execute({
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: shared.txt",
        "@@ -1,1 +1,1 @@",
        "-original",
        "+agent one",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    await writeFile(path, "user between\n");
    expect((await item.execute({
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: shared.txt",
        "@@ -1,1 +1,1 @@",
        "-user between",
        "+agent two",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    item.checkpoints.finishTurn(checkpointId);

    const refused = await item.checkpoints.undoLatest();

    expect(refused).toMatchObject({ status: "conflict" });
    expect(refused.status === "conflict" ? refused.message : "").toContain("between its writes");
    await expect(readFile(path, "utf8")).resolves.toBe("agent two\n");
  });

  it("treats a permission-only user change as an undo conflict", async () => {
    const path = join(workspace, "mode.txt");
    await writeFile(path, "before\n");
    await chmod(path, 0o640);
    const item = await fixture();
    const checkpointId = item.checkpoints.beginTurn();
    expect((await item.execute({
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: mode.txt",
        "@@ -1,1 +1,1 @@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    item.checkpoints.finishTurn(checkpointId);
    await chmod(path, 0o600);

    expect(await item.checkpoints.undoLatest()).toMatchObject({ status: "conflict" });
    await expect(readFile(path, "utf8")).resolves.toBe("after\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("only considers the most recent completed turn", async () => {
    await writeFile(join(workspace, "file.txt"), "before\n");
    const item = await fixture();
    const first = item.checkpoints.beginTurn();
    expect((await item.execute({
      baseHash: sha256(await readFile(join(workspace, "file.txt"))),
      patch: [
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@ -1,1 +1,1 @@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    })).status).toBe("success");
    item.checkpoints.finishTurn(first);

    const second = item.checkpoints.beginTurn();
    item.checkpoints.finishTurn(second);

    expect(await item.checkpoints.undoLatest()).toMatchObject({
      status: "nothing_to_undo",
      message: "The latest agent turn did not change files.",
    });
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("after\n");
  });
});
