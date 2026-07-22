import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface ShellSpawnRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SandboxStatus {
  readonly enforced: boolean;
  readonly network: "isolated" | "unrestricted";
  readonly warning?: string | undefined;
}

/** The next chapter can replace this boundary with an OS-specific sandbox. */
export interface SandboxRunner {
  readonly status: SandboxStatus;
  spawn(request: ShellSpawnRequest): ChildProcessWithoutNullStreams;
}

export class HostSandboxRunner implements SandboxRunner {
  readonly status: SandboxStatus = Object.freeze({
    enforced: false,
    network: "unrestricted",
    warning: "OS sandbox unavailable: command runs on the host and network access is not isolated.",
  });

  spawn(request: ShellSpawnRequest): ChildProcessWithoutNullStreams {
    const options: SpawnOptionsWithoutStdio = {
      cwd: request.cwd,
      env: request.env,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "pipe",
    };
    return spawn(request.command, options);
  }
}
