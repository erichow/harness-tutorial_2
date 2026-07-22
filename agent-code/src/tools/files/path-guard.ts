import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { WorkspaceFilePolicy } from "./policy.js";

export interface ResolvedWorkspacePath {
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly realPath: string;
}

export class WorkspacePathGuard {
  readonly root: string;
  readonly #policy: WorkspaceFilePolicy;

  private constructor(root: string, policy: WorkspaceFilePolicy) {
    this.root = root;
    this.#policy = policy;
    Object.freeze(this);
  }

  static async create(
    workspaceRoot: string,
    policy = new WorkspaceFilePolicy(),
  ): Promise<WorkspacePathGuard> {
    const root = await realpath(workspaceRoot);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new TypeError("workspaceRoot must be a directory");
    return new WorkspacePathGuard(root, policy);
  }

  normalize(input: string, allowRoot = false): string {
    if (input.includes("\0")) throw new Error("Path contains a null byte");
    if (input.includes("\\")) throw new Error("Paths must use forward slashes");
    if (isAbsolute(input) || win32.isAbsolute(input)) {
      throw new Error("Absolute paths are not allowed");
    }

    const lexicalPath = resolve(this.root, input || ".");
    const relativePath = relative(this.root, lexicalPath).split(sep).join("/");
    if (relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error("Path escapes the workspace root");
    }
    if (relativePath === "" && !allowRoot) {
      throw new Error("A workspace-relative path is required");
    }
    const reason = this.#policy.blockedReason(relativePath);
    if (reason !== undefined) throw new Error(reason);
    return relativePath;
  }

  async resolveExisting(input: string, allowRoot = false): Promise<ResolvedWorkspacePath> {
    const relativePath = this.normalize(input, allowRoot);
    const lexicalPath = resolve(this.root, relativePath || ".");
    const target = await realpath(lexicalPath);
    this.#assertInside(target);
    const resolvedRelativePath = relative(this.root, target).split(sep).join("/");
    const reason = this.#policy.blockedReason(resolvedRelativePath);
    if (reason !== undefined) throw new Error(reason);
    return { relativePath, lexicalPath, realPath: target };
  }

  async resolveForWrite(input: string): Promise<{
    readonly relativePath: string;
    readonly lexicalPath: string;
    readonly exists: boolean;
  }> {
    const relativePath = this.normalize(input);
    const lexicalPath = resolve(this.root, relativePath);
    const segments = relativePath.split("/");
    let current = this.root;

    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index] ?? "");
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new Error(`Writes through symbolic links are not allowed: ${relativePath}`);
        }
        if (index < segments.length - 1 && !metadata.isDirectory()) {
          throw new Error(`Path parent is not a directory: ${relativePath}`);
        }
      } catch (error) {
        if (isMissing(error)) {
          if (index < segments.length - 1) {
            throw new Error(`Path parent does not exist: ${relativePath}`);
          }
          return { relativePath, lexicalPath, exists: false };
        }
        throw error;
      }
    }

    return { relativePath, lexicalPath, exists: true };
  }

  #assertInside(target: string): void {
    const candidate = relative(this.root, target);
    if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
      throw new Error("Resolved path escapes the workspace root through a symbolic link");
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
