import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProcessManager } from "../../src/tools/shell/process-manager.js";
import {
  createPlatformSandboxRunner,
  isMacOsSeatbeltAvailable,
  MacOsSeatbeltRunner,
} from "../../src/tools/shell/sandbox-runner.js";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "dugsyn-sandbox-"));
}

describe("platform sandbox selection", () => {
  it("fails closed when no supported sandbox is available", async () => {
    const root = await workspace();
    const runner = createPlatformSandboxRunner({ workspaceRoot: root, platform: "linux", fallback: "closed" });
    const manager = await ProcessManager.create({ workspaceRoot: root, runner });

    expect(runner.status).toMatchObject({ enforced: false, network: "blocked", filesystem: "blocked" });
    await expect(manager.run({ command: "printf blocked" })).rejects.toThrow("fail-closed");
    await manager.dispose();
  });

  it("labels an explicit fail-open fallback as unrestricted", async () => {
    const root = await workspace();
    const runner = createPlatformSandboxRunner({ workspaceRoot: root, platform: "linux", fallback: "open" });

    expect(runner.status).toMatchObject({ enforced: false, network: "unrestricted", filesystem: "host" });
    expect(runner.status.warning).toContain("runs on the host");
  });

  it.runIf(isMacOsSeatbeltAvailable())(
    "uses Seatbelt to allow workspace writes and deny reads outside it",
    async () => {
      const root = await workspace();
      const outside = join(tmpdir(), `dugsyn-secret-${process.pid}.txt`);
      await writeFile(outside, "do-not-read", "utf8");
      const runner = new MacOsSeatbeltRunner({
        workspaceRoot: root,
        allowNetwork: false,
        executable: "/usr/bin/sandbox-exec",
      });
      const manager = await ProcessManager.create({ workspaceRoot: root, runner });

      const allowed = await manager.run({ command: "printf allowed > result.txt" });
      const denied = await manager.run({ command: `cat '${outside}'` });

      expect(runner.status).toEqual({ enforced: true, network: "isolated", filesystem: "workspace-only" });
      expect(allowed.exitCode).toBe(0);
      await expect(readFile(join(root, "result.txt"), "utf8")).resolves.toBe("allowed");
      expect(denied.exitCode).not.toBe(0);
      expect(manager.readJob(denied.jobId, undefined, 4_096).output.text).not.toContain("do-not-read");
      await manager.dispose();
    },
  );
});
