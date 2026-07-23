import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolResultBlock } from "../../src/messages/blocks.js";
import { createTranscript } from "../../src/messages/transcript.js";
import type { JsonObject } from "../../src/protocol/json.js";
import { MockProvider } from "../../src/providers/mock.js";
import { runTurn } from "../../src/runtime/agent.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createWorkspaceFileTools } from "../../src/tools/files/index.js";
import { sha256 } from "../../src/tools/files/text.js";

const signal = new AbortController().signal;

describe("workspace file tools", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-code-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "agent-code-outside-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  async function tools(options: { maxFileBytes?: number; maxOutputBytes?: number } = {}) {
    const definitions = await createWorkspaceFileTools({
      workspaceRoot: workspace,
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    });
    return new ToolRegistry(definitions, {
      maxOutputBytes: options.maxOutputBytes ?? 16_384,
    }).createExecutor();
  }

  async function execute(
    name: string,
    input: JsonObject,
    options?: { maxFileBytes?: number; maxOutputBytes?: number },
  ): Promise<ToolResultBlock> {
    return await (await tools(options)).execute(
      { type: "tool_call", id: `call-${name}`, name, input },
      { signal },
    );
  }

  it("lists deterministically while excluding metadata, dependencies, and secrets", async () => {
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, "node_modules"));
    await writeFile(join(workspace, "src", "z.ts"), "z\n");
    await writeFile(join(workspace, "src", "a.ts"), "a\n");
    await writeFile(join(workspace, ".git", "config"), "secret\n");
    await writeFile(join(workspace, "node_modules", "package.js"), "dependency\n");
    await writeFile(join(workspace, ".env.local"), "TOKEN=secret\n");
    await writeFile(join(workspace, ".env.example"), "TOKEN=\n");

    const result = await execute("list_files", { path: ".", maxDepth: 3 });

    expect(result.status).toBe("success");
    expect(result.content).toContain(".env.example");
    expect(result.content).toContain("src/a.ts");
    expect(result.content.indexOf("src/a.ts")).toBeLessThan(result.content.indexOf("src/z.ts"));
    expect(result.content).not.toContain(".git");
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain(".env.local");
  });

  it("rejects lexical, absolute, Windows-style, and symlink escapes", async () => {
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(join(outside, "secret.txt"), join(workspace, "outside-link.txt"));
    await writeFile(join(workspace, ".env.local"), "TOKEN=secret\n");
    await symlink(".env.local", join(workspace, "secret-alias.txt"));

    for (const path of ["../secret.txt", join(outside, "secret.txt"), "C:/secret.txt", "outside-link.txt", "secret-alias.txt"]) {
      const result = await execute("read_file", { path });
      expect(result.status, path).toBe("error");
    }
  });

  it("allows reads through an internal symlink but rejects writes through it", async () => {
    await writeFile(join(workspace, "actual.txt"), "hello\n");
    await symlink("actual.txt", join(workspace, "alias.txt"));
    const read = await execute("read_file", { path: "alias.txt" });
    const hash = sha256(await readFile(join(workspace, "actual.txt")));

    expect(read.status).toBe("success");
    expect(read.content).toContain("hello");

    const changed = await execute("apply_patch", {
      baseHash: hash,
      patch: [
        "*** Begin Patch",
        "*** Update File: alias.txt",
        "@@ -1,1 +1,1 @@",
        "-hello",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    });
    expect(changed.status).toBe("error");
    await expect(readFile(join(workspace, "actual.txt"), "utf8")).resolves.toBe("hello\n");
  });

  it("reads UTF-8 and empty files, and rejects binary, sensitive, and oversized files", async () => {
    await writeFile(join(workspace, "unicode.txt"), "你好 🙂\n");
    await writeFile(join(workspace, "empty.txt"), "");
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0x61, 0, 0x62]));
    await writeFile(join(workspace, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(workspace, ".env"), "SECRET=x\n");
    await writeFile(join(workspace, "large.txt"), "123456789");

    const unicode = await execute("read_file", { path: "unicode.txt" });
    const empty = await execute("read_file", { path: "empty.txt" });
    const binary = await execute("read_file", { path: "binary.bin" });
    const invalidUtf8 = await execute("read_file", { path: "invalid-utf8.txt" });
    const sensitive = await execute("read_file", { path: ".env" });
    const large = await execute("read_file", { path: "large.txt" }, { maxFileBytes: 8 });

    expect(unicode.content).toContain("你好 🙂");
    expect(unicode.content).toMatch(/sha256:[a-f0-9]{64}/);
    expect(unicode).toMatchObject({
      data: { version: { algorithm: "sha256", value: expect.stringMatching(/^sha256:/u) } },
    });
    expect(empty).toMatchObject({ status: "success", data: { totalLines: 0 } });
    expect(binary.content).toContain("Binary files");
    expect(invalidUtf8.content).toContain("not valid UTF-8");
    expect(sensitive.content).toContain("Sensitive file");
    expect(large.content).toContain("read limit");
  });

  it("searches literal text and skips protected, binary, and oversized files", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "a.ts"), "Needle here\nneedle again\n");
    await writeFile(join(workspace, ".env.local"), "needle secret\n");
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));

    const exact = await execute("search_text", { query: "Needle" });
    const folded = await execute("search_text", { query: "needle", caseSensitive: false });

    expect(exact.content).toContain("src/a.ts:1:1");
    expect(exact.content).not.toContain("src/a.ts:2");
    expect(exact.content).not.toContain(".env.local");
    expect(folded.content).toContain("matches: 2");
    expect(folded).toMatchObject({ data: { filesSkipped: 1 } });
  });

  it("creates, modifies, and deletes files with checked patches", async () => {
    const add = await execute("apply_patch", {
      baseHash: null,
      patch: [
        "*** Begin Patch",
        "*** Add File: greeting.txt",
        "+alpha",
        "+beta",
        "*** End Patch",
      ].join("\n"),
    });
    expect(add.status).toBe("success");
    await expect(readFile(join(workspace, "greeting.txt"), "utf8")).resolves.toBe("alpha\nbeta\n");

    const beforeHash = sha256(await readFile(join(workspace, "greeting.txt")));
    const update = await execute("apply_patch", {
      baseHash: beforeHash,
      patch: [
        "*** Begin Patch",
        "*** Update File: greeting.txt",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+你好",
        "*** End Patch",
      ].join("\n"),
    });
    expect(update.status).toBe("success");
    expect(update.data).toMatchObject({
      additions: 1,
      deletions: 1,
      diff: expect.stringContaining("@@ -1,2 +1,2 @@"),
    });
    expect(update.content).toContain("-beta\n+你好");
    await expect(readFile(join(workspace, "greeting.txt"), "utf8")).resolves.toBe("alpha\n你好\n");

    const deleteHash = sha256(await readFile(join(workspace, "greeting.txt")));
    const deleted = await execute("apply_patch", {
      baseHash: deleteHash,
      patch: [
        "*** Begin Patch",
        "*** Delete File: greeting.txt",
        "*** End Patch",
      ].join("\n"),
    });
    expect(deleted.status).toBe("success");
    await expect(readFile(join(workspace, "greeting.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives models the complete patch grammar in definitions and format errors", async () => {
    const executor = await tools();
    const definition = executor.definitions.find((candidate) => candidate.name === "apply_patch");
    expect(definition?.description).toContain("*** Update File: path/to/file");
    expect(definition?.description).toContain("@@ -1,1 +1,1 @@");

    const malformed = await executor.execute({
      type: "tool_call",
      id: "malformed-patch",
      name: "apply_patch",
      input: {
        baseHash: `sha256:${"0".repeat(64)}`,
        patch: "Update src/config.js from 5000 to 10000",
      },
    }, { signal });

    expect(malformed).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    expect(malformed.content).toContain("Invalid patch format");
    expect(malformed.content).toContain("*** Begin Patch");
    expect(malformed.content).toContain("*** Update File: path/to/file");
  });

  it("rejects a stale version when the user edits while the agent is thinking", async () => {
    const path = join(workspace, "shared.txt");
    await writeFile(path, "first\n");
    const read = await execute("read_file", { path: "shared.txt" });
    const staleHash = (read.data as JsonObject).sha256;
    expect(staleHash).toBeTypeOf("string");
    await writeFile(path, "changed elsewhere\n");

    const stale = await execute("apply_patch", {
      baseHash: staleHash as string,
      patch: [
        "*** Begin Patch",
        "*** Update File: shared.txt",
        "@@ -1,1 +1,1 @@",
        "-first",
        "+agent",
        "*** End Patch",
      ].join("\n"),
    });
    expect(stale.content).toContain("File changed after it was read");
    await expect(readFile(path, "utf8")).resolves.toBe("changed elsewhere\n");

    const currentHash = sha256(await readFile(path));
    const mismatch = await execute("apply_patch", {
      baseHash: currentHash,
      patch: [
        "*** Begin Patch",
        "*** Update File: shared.txt",
        "@@ -1,1 +1,1 @@",
        "-not the current line",
        "+agent",
        "*** End Patch",
      ].join("\n"),
    });
    expect(mismatch.content).toContain("Patch context matched 0 locations");
    await expect(readFile(path, "utf8")).resolves.toBe("changed elsewhere\n");
    expect((await readdir(workspace)).some((name) => name.includes(".agent-code-") && name.endsWith(".tmp"))).toBe(false);
  });

  it("accepts one patch context match and rejects zero or multiple matches", async () => {
    const path = join(workspace, "matches.txt");
    await writeFile(path, "first\ntarget\nlast\n");
    const once = await execute("apply_patch", {
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: matches.txt",
        "@@ -99,1 +99,1 @@",
        "-target",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    });
    expect(once.status).toBe("success");
    await expect(readFile(path, "utf8")).resolves.toBe("first\nchanged\nlast\n");

    await writeFile(path, "same\nmiddle\nsame\n");
    const multiple = await execute("apply_patch", {
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: matches.txt",
        "@@ -1,1 +1,1 @@",
        "-same",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    });
    expect(multiple.status).toBe("error");
    expect(multiple.content).toContain("matched 2 locations");
    await expect(readFile(path, "utf8")).resolves.toBe("same\nmiddle\nsame\n");
  });

  it("does not record a textual no-op as a file modification", async () => {
    const path = join(workspace, "same.txt");
    await writeFile(path, "unchanged\n");
    const result = await execute("apply_patch", {
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: same.txt",
        "@@ -1,1 +1,1 @@",
        "-unchanged",
        "+unchanged",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.status).toBe("error");
    expect(result.content).toContain("Patch does not change the file");
    await expect(readFile(path, "utf8")).resolves.toBe("unchanged\n");
  });

  it("serializes concurrent edits so only one tool can commit the same base version", async () => {
    const path = join(workspace, "concurrent.txt");
    await writeFile(path, "original\n");
    const baseHash = sha256(await readFile(path));
    const executor = await tools();
    const call = (id: string, replacement: string, patchPath: string) => executor.execute({
      type: "tool_call" as const,
      id,
      name: "apply_patch",
      input: {
        baseHash,
        patch: [
          "*** Begin Patch",
          `*** Update File: ${patchPath}`,
          "@@ -1,1 +1,1 @@",
          "-original",
          `+${replacement}`,
          "*** End Patch",
        ].join("\n"),
      },
    }, { signal });

    const results = await Promise.all([
      call("writer-a", "alpha", "concurrent.txt"),
      call("writer-b", "beta", "./concurrent.txt"),
    ]);
    expect(results.filter((result) => result.status === "success")).toHaveLength(1);
    expect(results.find((result) => result.status === "success")?.data)
      .toMatchObject({ path: "concurrent.txt" });
    const rejected = results.find((result) => result.status === "error");
    expect(rejected?.content).toContain("File changed after it was read");
    expect(["alpha\n", "beta\n"]).toContain(await readFile(path, "utf8"));
  });

  it("applies multiple uniquely matched hunks against the same base version", async () => {
    const path = join(workspace, "multi.txt");
    await writeFile(path, "alpha\nbetween\ngamma\n");
    const result = await execute("apply_patch", {
      baseHash: sha256(await readFile(path)),
      patch: [
        "*** Begin Patch",
        "*** Update File: multi.txt",
        "@@ -1,1 +1,2 @@",
        "-alpha",
        "+alpha-one",
        "+alpha-two",
        "@@ -3,1 +4,1 @@",
        "-gamma",
        "+gamma-changed",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.status).toBe("success");
    await expect(readFile(path, "utf8"))
      .resolves.toBe("alpha-one\nalpha-two\nbetween\ngamma-changed\n");
    expect(result.data).toMatchObject({ additions: 3, deletions: 2 });
  });

  it("preserves a UTF-8 BOM, CRLF style, and trailing newline when updating", async () => {
    const path = join(workspace, "windows.txt");
    const before = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\r\n", "utf8"),
    ]);
    await writeFile(path, before);

    const result = await execute("apply_patch", {
      baseHash: sha256(before),
      patch: [
        "*** Begin Patch",
        "*** Update File: windows.txt",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "+three",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.status).toBe("success");
    await expect(readFile(path)).resolves.toEqual(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\nthree\r\n", "utf8"),
    ]));
  });

  it("paginates bounded output and invalidates a read cursor after a file change", async () => {
    const path = join(workspace, "many.txt");
    await writeFile(path, Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n"));
    const executor = await tools({ maxOutputBytes: 180 });
    const first = await executor.execute(
      { type: "tool_call", id: "read-1", name: "read_file", input: { path: "many.txt" } },
      { signal },
    );
    expect(first).toMatchObject({ status: "success", output: { truncated: false } });
    expect(first.output?.nextCursor).toBeTypeOf("string");

    await writeFile(path, "replaced\n");
    const second = await executor.execute(
      {
        type: "tool_call",
        id: "read-2",
        name: "read_file",
        input: { path: "many.txt", cursor: first.output?.nextCursor ?? "" },
      },
      { signal },
    );
    expect(second).toMatchObject({ status: "error" });
    expect(second.content).toContain("Invalid or stale cursor");
  });

  it("runs a real file tool through the agent loop and returns its result to the provider", async () => {
    await writeFile(join(workspace, "answer.txt"), "forty-two\n");
    const provider = new MockProvider([
      {
        events: [
          {
            type: "tool_call",
            call: {
              type: "tool_call",
              id: "read-answer",
              name: "read_file",
              input: { path: "answer.txt" },
            },
          },
          { type: "response_completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "text_delta", delta: "The answer is forty-two." },
          { type: "response_completed", finishReason: "stop" },
        ],
      },
    ]);
    const result = await runTurn({
      provider,
      transcript: createTranscript(),
      tools: await tools(),
    });

    expect(result.reason).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.transcript.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "read-answer",
          status: "success",
          content: expect.stringContaining("forty-two"),
        },
      ],
    });
  });
});
