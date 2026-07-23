import { realpath, stat } from "node:fs/promises";

export type ProjectFeature = "config" | "hooks" | "mcp" | "permission_rules" | "skills";

export interface WorkspaceTrustOptions {
  readonly workspaceRoot: string;
  readonly trustedRoots?: readonly string[] | undefined;
}

/** Trust is attached to canonical directories so symlink aliases cannot change it. */
export class WorkspaceTrust {
  readonly workspaceRoot: string;
  readonly trusted: boolean;

  private constructor(workspaceRoot: string, trusted: boolean) {
    this.workspaceRoot = workspaceRoot;
    this.trusted = trusted;
    Object.freeze(this);
  }

  static async create(options: WorkspaceTrustOptions): Promise<WorkspaceTrust> {
    const workspaceRoot = await canonicalDirectory(options.workspaceRoot);
    const trustedRoots = await Promise.all(
      (options.trustedRoots ?? []).map(async (root) => await canonicalDirectory(root)),
    );
    return new WorkspaceTrust(workspaceRoot, trustedRoots.includes(workspaceRoot));
  }

  projectFeature(feature: ProjectFeature): {
    readonly enabled: boolean;
    readonly reason?: string | undefined;
  } {
    if (this.trusted) return { enabled: true };
    return {
      enabled: false,
      reason: `Project ${feature} is disabled until the workspace is trusted.`,
    };
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new TypeError(`Not a directory: ${path}`);
  return canonical;
}
