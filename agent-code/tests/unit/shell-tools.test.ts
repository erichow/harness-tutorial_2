import { access, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/protocol/json.js";
import { MockProvider } from "../../src/providers/mock.js";
import { createTranscript } from "../../src/messages/transcript.js";
import { runTurn } from "../../src/runtime/agent.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createShellTools } from "../../src/tools/shell/index.js";
import { ProcessManager } from "../../src/tools/shell/process-manager.js";

const managers: ProcessManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => await manager.dispose()));
});

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-code-shell-"));
}

async function manager(options: Partial<Parameters<typeof ProcessManager.create>[0]> = {}) {
  const root = options.workspaceRoot ?? await workspace();
  const created = await ProcessManager.create({
    ...options,
    workspaceRoot: root,
  });
  managers.push(created);
  return created;
}

async function shellTools(options: Partial<Parameters<typeof createShellTools>[0]> = {}) {
  const root = options.workspaceRoot ?? await workspace();
  const created = await createShellTools({
    ...options,
    workspaceRoot: root,
  });
  managers.push(created.processManager);
  return created;
}

function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function call(id: string, name: string, input: JsonObject) {
  return { type: "tool_call" as const, id, name, input };
}

describe("ProcessManager", () => {
  it.runIf(process.platform !== "win32")("kills a POSIX process tree on timeout", async () => {
    const root = await workspace();
    const ready = join(root, "parent-started.txt");
    const marker = join(root, "descendant-survived.txt");
    const processes = await manager({ workspaceRoot: root, terminationGraceMs: 50 });
    const command = `printf started > ${shellQuote(ready)}; ` +
      `(sleep 2; printf alive > ${shellQuote(marker)}) & ` +
      "while :; do sleep 1; done";

    const result = await processes.run({ command, timeoutMs: 1_000 });
    await delay(1_200);

    expect(result.exitReason).toBe("timeout");
    await expect(access(ready)).resolves.toBeUndefined();
    await expect(access(marker)).rejects.toThrow();
  }, 10_000);

  it("cancels only the current command and remains reusable", async () => {
    const processes = await manager({ terminationGraceMs: 20 });
    const controller = new AbortController();
    const pending = processes.run({
      command: nodeCommand("setInterval(() => {}, 1000)"),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("user pressed Ctrl-C")), 40);

    await expect(pending).rejects.toThrow("user pressed Ctrl-C");
    const next = await processes.run({ command: nodeCommand('process.stdout.write("still-alive")') });

    expect(next.exitReason).toBe("exit");
    expect(processes.readJob(next.jobId, undefined, 1_024).output.text).toContain("still-alive");
  });

  it("bounds infinite stdout and stderr while retaining a head and tail", async () => {
    const processes = await manager({ maxCaptureBytes: 4_096, terminationGraceMs: 20 });
    const command = process.platform === "win32"
      ? nodeCommand('const c="x".repeat(16384);process.stdout.write(c);process.stderr.write(c);setInterval(()=>{process.stdout.write(c);process.stderr.write(c)},0)')
      : "while :; do printf 0123456789abcdef; printf fedcba9876543210 >&2; done";

    const result = await processes.run({ command, timeoutMs: process.platform === "win32" ? 3_000 : 300 });
    const view = processes.readJob(result.jobId, undefined, 512);

    expect(result.exitReason).toBe("timeout");
    expect(view.output.totalBytes).toBeGreaterThan(4_096);
    expect(view.output.retainedBytes).toBeLessThanOrEqual(4_096);
    expect(view.output.omittedBytes).toBeGreaterThan(0);
    expect(view.nextCursor).toBeDefined();
  }, 10_000);

  it("starts, polls, stops, and cleans up a background job", async () => {
    const processes = await manager({ terminationGraceMs: 20 });
    const started = await processes.startJob({
      command: nodeCommand('process.stdout.write("tick\\n"); setInterval(() => process.stdout.write("tick\\n"), 10)'),
      timeoutMs: 5_000,
    });
    let polled = processes.readJob(started.jobId, undefined, 1_024);
    for (let attempt = 0; attempt < 100 && !polled.output.text.includes("tick"); attempt += 1) {
      await delay(25);
      polled = processes.readJob(started.jobId, undefined, 1_024);
    }
    const stopped = await processes.stopJob(started.jobId);

    expect(polled.status).toBe("running");
    expect(polled.output.text).toContain("tick");
    expect(stopped).toMatchObject({ status: "exited", exitReason: "stopped" });
    expect(processes.cleanupFinished(started.jobId)).toBe(1);
    expect(() => processes.readJob(started.jobId, undefined, 1_024)).toThrow("Unknown job");
  }, 10_000);

  it("uses workspace-relative cwd and a minimal environment plus explicit additions", async () => {
    const root = await workspace();
    await mkdir(join(root, "nested"));
    const processes = await manager({
      workspaceRoot: root,
      environment: { TUTORIAL_VISIBLE: "yes" },
      environmentAllowlist: ["PATH"],
    });
    const source = "process.stdout.write(JSON.stringify({cwd:process.cwd(),visible:process.env.TUTORIAL_VISIBLE,home:process.env.HOME??null}))";

    const result = await processes.run({ command: nodeCommand(source), cwd: "nested" });
    const output = processes.readJob(result.jobId, undefined, 2_048).output.text;

    expect(output).toContain('"visible":"yes"');
    expect(output).toContain('"home":null');
    expect(output).toContain("nested");
    await expect(processes.run({ command: "pwd", cwd: "../" })).rejects.toThrow("escapes");
    await expect(processes.run({ command: "pwd", cwd: "/tmp" })).rejects.toThrow("relative");
    await expect(processes.run({ command: "pwd", cwd: "C:/Windows" })).rejects.toThrow("relative");
  });
});

describe("shell tools", () => {
  it("treats a compound command as one effectful shell program", async () => {
    const created = await shellTools();
    const runTool = created.tools.find((tool) => tool.definition.name === "run_shell");
    expect(runTool?.sideEffects).toEqual(["execute_process", "network"]);
    expect(created.warning).toContain("OS sandbox unavailable");

    const executor = new ToolRegistry(created.tools).createExecutor();
    const result = await executor.execute(
      call("compound", "run_shell", { command: "printf first && printf second" }),
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("firstsecond");
    expect(result.content).toContain("filesystem and network access are unrestricted");
  });

  it("paginates retained output with a job-bound cursor", async () => {
    const created = await shellTools({ maxCaptureBytes: 8_192 });
    const executor = new ToolRegistry(created.tools, { maxOutputBytes: 512 }).createExecutor();
    const first = await executor.execute(
      call("page-1", "run_shell", {
        command: nodeCommand('process.stdout.write("a".repeat(2000))'),
      }),
      { signal: new AbortController().signal },
    );
    expect(first.status).toBe("success");
    expect(first.output?.nextCursor).toBeDefined();
    const jobId = (first.data as { jobId: string }).jobId;
    const cursor = first.output?.nextCursor;
    if (cursor === undefined) throw new Error("expected paginated shell output");

    const second = await executor.execute(
      call("page-2", "read_job", {
        jobId,
        cursor,
      }),
      { signal: new AbortController().signal },
    );
    const other = await created.processManager.run({ command: "printf other" });
    const wrongCursor = await executor.execute(
      call("wrong-cursor", "read_job", {
        jobId: other.jobId,
        cursor,
      }),
      { signal: new AbortController().signal },
    );

    expect(second.status).toBe("success");
    expect(wrongCursor).toMatchObject({ status: "error" });
    expect(wrongCursor.content).toContain("Invalid or stale output cursor");
  });

  it("lets an Agent turn cancel a running shell call without exiting the runtime", async () => {
    const created = await shellTools({ terminationGraceMs: 20 });
    const provider = new MockProvider([
      {
        events: [
          { type: "tool_call", call: call("shell-call", "run_shell", {
            command: nodeCommand("setInterval(() => {}, 1000)"),
            timeoutMs: 5_000,
          }) },
          { type: "response_completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const controller = new AbortController();
    const turn = runTurn({
      provider,
      transcript: createTranscript(),
      tools: new ToolRegistry(created.tools).createExecutor(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("Ctrl-C")), 50);

    await expect(turn).resolves.toMatchObject({ reason: "cancelled" });
    const reusable = await created.processManager.run({ command: "printf reusable" });
    expect(reusable.exitReason).toBe("exit");
  });

  it("can remove a completed job after its final output page", async () => {
    const created = await shellTools();
    const executor = new ToolRegistry(created.tools).createExecutor();
    const started = await executor.execute(
      call("start", "start_job", { command: "printf done" }),
      { signal: new AbortController().signal },
    );
    const jobId = (started.data as { jobId: string }).jobId;
    let status = created.processManager.readJob(jobId, undefined, 1_024).status;
    for (let attempt = 0; attempt < 100 && status === "running"; attempt += 1) {
      await delay(20);
      status = created.processManager.readJob(jobId, undefined, 1_024).status;
    }

    const cleaned = await executor.execute(
      call("clean", "read_job", { jobId, cleanup: true }),
      { signal: new AbortController().signal },
    );
    const missing = await executor.execute(
      call("missing", "read_job", { jobId }),
      { signal: new AbortController().signal },
    );

    expect(cleaned).toMatchObject({ status: "success", data: { cleanedUp: true } });
    expect(missing.content).toContain("Unknown job");
  });
});
