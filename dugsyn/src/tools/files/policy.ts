import { posix } from "node:path";

export const DEFAULT_DEPENDENCY_DIRECTORIES = Object.freeze([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
]);

const SAFE_ENV_SUFFIXES = new Set([".example", ".sample", ".template"]);
const SENSITIVE_EXACT_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

export interface WorkspaceFilePolicyOptions {
  readonly dependencyDirectories?: readonly string[] | undefined;
}

export class WorkspaceFilePolicy {
  readonly #dependencies: ReadonlySet<string>;

  constructor(options: WorkspaceFilePolicyOptions = {}) {
    this.#dependencies = new Set(
      options.dependencyDirectories ?? DEFAULT_DEPENDENCY_DIRECTORIES,
    );
  }

  blockedReason(relativePath: string): string | undefined {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.includes(".git")) return "Git metadata is not accessible";
    const dependency = segments.find((segment) => this.#dependencies.has(segment));
    if (dependency !== undefined) {
      return `Dependency directory is not accessible: ${dependency}`;
    }
    const name = segments.at(-1);
    if (name !== undefined && isSensitiveFileName(name)) {
      return `Sensitive file is not accessible: ${name}`;
    }
    return undefined;
  }

  shouldSkip(relativePath: string): boolean {
    return this.blockedReason(relativePath) !== undefined;
  }
}

export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) {
    return ![...SAFE_ENV_SUFFIXES].some((suffix) => lower.endsWith(suffix));
  }
  if (SENSITIVE_EXACT_NAMES.has(lower)) return true;
  return SENSITIVE_EXTENSIONS.has(posix.extname(lower));
}
