import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface ShellSpawnRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SandboxStatus {
  readonly enforced: boolean;
  readonly network: "isolated" | "unrestricted" | "blocked";
  readonly filesystem: "workspace-only" | "host" | "blocked";
  readonly warning?: string | undefined;
}

/** ProcessManager uses this boundary without assuming how isolation is enforced. */
export interface SandboxRunner {
  readonly status: SandboxStatus;
  spawn(request: ShellSpawnRequest): ChildProcessWithoutNullStreams;
}

export class HostSandboxRunner implements SandboxRunner {
  readonly status: SandboxStatus = Object.freeze({
    enforced: false,
    network: "unrestricted",
    filesystem: "host",
    warning: "OS sandbox unavailable: command runs on the host; filesystem and network access are unrestricted.",
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

export type SandboxFallback = "closed" | "open";

export interface PlatformSandboxOptions {
  readonly workspaceRoot: string;
  readonly allowNetwork?: boolean | undefined;
  readonly fallback?: SandboxFallback | undefined;
  /** Test seam for simulating an unavailable platform sandbox. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly sandboxExecutable?: string | undefined;
}

/**
 * Select an actual OS sandbox when this tutorial has a tested implementation.
 * Unsupported platforms never silently become "sandboxed".
 */
export function createPlatformSandboxRunner(options: PlatformSandboxOptions): SandboxRunner {
  const platform = options.platform ?? process.platform;
  const executable = options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
  if (platform === "darwin" && isMacOsSeatbeltAvailable(executable)) {
    return new MacOsSeatbeltRunner({
      workspaceRoot: options.workspaceRoot,
      allowNetwork: options.allowNetwork ?? false,
      executable,
    });
  }
  if ((options.fallback ?? "closed") === "open") return new HostSandboxRunner();
  return new ClosedSandboxRunner(platform);
}

export function isMacOsSeatbeltAvailable(executable = "/usr/bin/sandbox-exec"): boolean {
  if (process.platform !== "darwin" || !existsSync(executable)) return false;
  const probe = spawnSync(executable, [
    "-p",
    "(version 1)(allow default)",
    "/usr/bin/true",
  ], { stdio: "ignore" });
  return probe.status === 0;
}

export class ClosedSandboxRunner implements SandboxRunner {
  readonly status: SandboxStatus;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.status = Object.freeze({
      enforced: false,
      network: "blocked",
      filesystem: "blocked",
      warning: `OS sandbox unavailable on ${platform}: fail-closed mode blocks command execution.`,
    });
  }

  spawn(_request: ShellSpawnRequest): ChildProcessWithoutNullStreams {
    throw new Error(this.status.warning);
  }
}

interface MacOsSeatbeltOptions {
  readonly workspaceRoot: string;
  readonly allowNetwork: boolean;
  readonly executable: string;
}

/** macOS Seatbelt runner. The profile allows reads needed by system programs and the workspace only. */
export class MacOsSeatbeltRunner implements SandboxRunner {
  readonly status: SandboxStatus;
  readonly #workspaceRoot: string;
  readonly #allowNetwork: boolean;
  readonly #executable: string;

  constructor(options: MacOsSeatbeltOptions) {
    this.#workspaceRoot = realpathSync(options.workspaceRoot);
    if (!statSync(this.#workspaceRoot).isDirectory()) {
      throw new TypeError("workspaceRoot must be a directory");
    }
    this.#allowNetwork = options.allowNetwork;
    this.#executable = options.executable;
    this.status = Object.freeze({
      enforced: true,
      network: options.allowNetwork ? "unrestricted" : "isolated",
      filesystem: "workspace-only",
    });
  }

  spawn(request: ShellSpawnRequest): ChildProcessWithoutNullStreams {
    const options: SpawnOptionsWithoutStdio = {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: "pipe",
    };
    return spawn(this.#executable, [
      "-p",
      this.#profile(),
      "/bin/sh",
      "-c",
      request.command,
    ], options);
  }

  #profile(): string {
    const readableRoots = [
      "/System",
      "/Library",
      "/usr",
      "/bin",
      "/sbin",
      "/dev",
      "/private/etc",
      "/private/var/db",
      dirname(process.execPath),
      this.#workspaceRoot,
    ];
    const lines = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow signal (target self))",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      ...readableRoots.map((path) => `(allow file-read* (subpath ${seatbeltString(path)}))`),
      `(allow file-write* (subpath ${seatbeltString(this.#workspaceRoot)}))`,
      `(allow file-write* (literal ${seatbeltString("/dev/null")}))`,
    ];
    if (this.#allowNetwork) lines.push("(allow network*)");
    return lines.join("\n");
  }
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}
