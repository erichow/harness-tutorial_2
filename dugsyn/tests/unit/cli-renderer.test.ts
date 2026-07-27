import { describe, expect, it } from "vitest";

import { createTerminalPermissionHandler } from "../../src/cli/permission-prompt.js";
import { TerminalRenderer } from "../../src/cli/renderer.js";
import type { InputController, ReadLineOptions } from "../../src/cli/input.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { normalizePermissionRequest } from "../../src/security/permissions.js";

const base = {
  protocolVersion: 1 as const,
  timestamp: "2026-07-23T00:00:00.000Z",
  turnId: "turn-1",
};

function output(options: { isTTY?: boolean; columns?: number } = {}) {
  const chunks: string[] = [];
  return {
    target: {
      ...options,
      write(chunk: string) { chunks.push(chunk); },
    },
    text: () => chunks.join(""),
  };
}

class AnswerInput implements InputController {
  readonly prompts: string[] = [];
  #answers: string[];

  constructor(answers: string[]) {
    this.#answers = answers;
  }

  async readLine(prompt: string, options?: ReadLineOptions): Promise<string | null> {
    options?.signal?.throwIfAborted();
    this.prompts.push(prompt);
    return this.#answers.shift() ?? null;
  }

  onInterrupt(): () => void { return () => undefined; }
  close(): void {}
}

describe("TerminalRenderer", () => {
  it("keeps interleaved text and real tool events readable", () => {
    const sink = output({ columns: 120 });
    const renderer = new TerminalRenderer({ output: sink.target });
    const events: RuntimeEvent[] = [
      { ...base, sequence: 0, type: "text_delta", delta: "Checking" },
      {
        ...base,
        sequence: 1,
        type: "tool_call_started",
        call: { type: "tool_call", id: "call-1", name: "apply_patch", input: { path: "src/a.ts" } },
      },
      {
        ...base,
        sequence: 2,
        type: "tool_call_finished",
        result: {
          type: "tool_result",
          toolCallId: "call-1",
          status: "success",
          content: "ignored model-facing output",
          data: { operation: "update", path: "src/a.ts" },
        },
      },
      { ...base, sequence: 3, type: "text_delta", delta: "Done" },
      { ...base, sequence: 4, type: "turn_finished", reason: "completed" },
    ];

    for (const event of events) renderer.render(event);

    expect(sink.text()).toBe(
      "Checking\n→ apply_patch \"src/a.ts\"\n✓ apply_patch (update src/a.ts)\nDone\n",
    );
    expect(sink.text()).not.toContain("ignored model-facing output");
  });

  it("removes model and tool control sequences in non-TTY output", () => {
    const sink = output({ isTTY: false });
    const renderer = new TerminalRenderer({ output: sink.target });

    renderer.render({
      ...base,
      sequence: 0,
      type: "text_delta",
      delta: "safe\u001b[2J\u001b]0;owned\u0007 text\rhidden",
    });
    renderer.render({
      ...base,
      sequence: 1,
      type: "tool_call_started",
      call: {
        type: "tool_call",
        id: "call-1",
        name: "run_shell",
        input: { command: "printf '\u001b[31mpwn'" },
      },
    });

    expect(sink.text()).not.toMatch(/[\u001b\u0007\r]/u);
    expect(sink.text()).toContain("safe texthidden");
  });

  it("suppresses test summary when no tests have run", () => {
    const sink = output();
    const renderer = new TerminalRenderer({ output: sink.target });
    renderer.render({
      ...base,
      sequence: 0,
      type: "turn_finished",
      reason: "completed",
      tests: { status: "not_run", runs: 0, repairRounds: 0 },
    });
    expect(sink.text()).toBe("");
  });

  it.each([
    ["passed", "Tests: passed (2 runs)."],
    ["failed", "Tests: failed (timed_out)."],
  ] as const)("renders the deterministic %s test summary", (status, expected) => {
    const sink = output();
    const renderer = new TerminalRenderer({ output: sink.target });
    renderer.render({
      ...base,
      sequence: 0,
      type: "turn_finished",
      reason: "completed",
      tests: {
        status,
        runs: 2,
        repairRounds: 1,
        ...(status === "failed" ? { lastOutcome: "timed_out" } : {}),
      },
    });
    expect(sink.text()).toContain(expected);
  });

  it("buffers runtime events until a permission answer completes", async () => {
    const sink = output();
    const renderer = new TerminalRenderer({ output: sink.target });
    let release: ((answer: string) => void) | undefined;
    const input: InputController = {
      readLine: async () => await new Promise<string>((resolve) => { release = resolve; }),
      onInterrupt: () => () => undefined,
      close() {},
    };
    const handler = createTerminalPermissionHandler(input, renderer);
    const request = normalizePermissionRequest({
      toolName: "run_shell",
      input: { command: "npm test", cwd: "." },
      sideEffects: ["execute_process", "network"],
    });
    const pending = handler(request, "confirmation required", new AbortController().signal);
    await Promise.resolve();

    renderer.render({ ...base, sequence: 0, type: "text_delta", delta: "late output" });
    expect(sink.text()).not.toContain("late output");
    release?.("y");
    await expect(pending).resolves.toBe("allow_once");

    expect(sink.text()).toContain("Allowed once\nlate output");
  });

  it("reuses the injected input controller and validates permission choices", async () => {
    const sink = output();
    const input = new AnswerInput(["maybe", "a"]);
    const handler = createTerminalPermissionHandler(
      input,
      new TerminalRenderer({ output: sink.target }),
    );
    const request = normalizePermissionRequest({
      toolName: "apply_patch",
      input: { path: "src/a.ts" },
      sideEffects: ["write_workspace"],
    });

    await expect(handler(request, "edit", new AbortController().signal))
      .resolves.toBe("allow_session");
    expect(input.prompts).toHaveLength(2);
    expect(sink.text()).toContain("Please enter y, a, or n.");
  });

  it("does not print a second permission heading after the runtime event", () => {
    const sink = output();
    const renderer = new TerminalRenderer({ output: sink.target });
    const request = normalizePermissionRequest({
      toolName: "apply_patch",
      input: { path: "src/a.ts" },
      sideEffects: ["write_workspace"],
    });
    renderer.render({
      ...base,
      sequence: 0,
      type: "permission_requested",
      requestId: request.fingerprint,
      toolCallId: "patch-1",
      toolName: "apply_patch",
      reason: "edit",
    });

    renderer.beginPermission(request, "edit");

    expect(sink.text().match(/Permission requested by apply_patch/gu)).toHaveLength(1);
  });
});
