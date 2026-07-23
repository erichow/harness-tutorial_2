import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ZodIssue } from "zod";

import type { PermissionRule } from "../security/permissions.js";
import { WorkspaceTrust } from "../security/trust.js";
import { configurationSchema, hookEventNames, type Configuration } from "./schema.js";

export type ConfigurationLayer = "managed" | "user" | "project" | "local";

export interface ConfigurationPaths {
  readonly managed?: string | undefined;
  readonly user?: string | undefined;
  readonly project?: string | undefined;
  readonly local?: string | undefined;
}

export interface LoadConfigurationOptions {
  readonly workspaceRoot: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  readonly paths?: ConfigurationPaths | undefined;
}

export interface LoadedConfigurationFile {
  readonly layer: ConfigurationLayer;
  readonly path: string;
}

export interface SkippedConfigurationFile extends LoadedConfigurationFile {
  readonly reason: string;
}

export interface LoadedConfiguration {
  readonly trust: WorkspaceTrust;
  readonly provider?: "openai" | "deepseek" | undefined;
  /** Explicit AGENT_CODE_MODEL override, independent of the selected provider. */
  readonly model?: string | undefined;
  readonly models: Readonly<NonNullable<Configuration["models"]>>;
  readonly sessionDirectory?: string | undefined;
  readonly trustedWorkspaces: readonly string[];
  readonly context: Readonly<NonNullable<Configuration["context"]>>;
  readonly instructions: Readonly<NonNullable<Configuration["instructions"]>>;
  readonly turn: Readonly<NonNullable<Configuration["turn"]>>;
  readonly permissions: {
    readonly defaultDecision?: "allow" | "ask" | "deny" | undefined;
    readonly managedRules: readonly PermissionRule[];
    readonly userRules: readonly PermissionRule[];
    readonly projectRules: readonly PermissionRule[];
  };
  readonly mcpServers: Readonly<NonNullable<Configuration["mcpServers"]>>;
  readonly hooks: Readonly<NonNullable<Configuration["hooks"]>>;
  readonly skills: Readonly<NonNullable<Configuration["skills"]>>;
  readonly loadedFiles: readonly LoadedConfigurationFile[];
  readonly skippedFiles: readonly SkippedConfigurationFile[];
}

export class ConfigurationError extends Error {
  readonly source: string;
  readonly field: string;

  constructor(source: string, field: string, reason: string, options?: ErrorOptions) {
    super(`Invalid configuration in ${source} at ${field}: ${reason}`, options);
    this.name = "ConfigurationError";
    this.source = source;
    this.field = field;
  }
}

interface LayerDocument {
  readonly layer: ConfigurationLayer;
  readonly path: string;
  readonly value: Configuration;
}

/** Loads global policy first, then reads project-owned files only after trust. */
export async function loadConfiguration(
  options: LoadConfigurationOptions,
): Promise<LoadedConfiguration> {
  const environment = options.environment ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot);
  const paths = resolvePaths(options.paths, environment, cwd, workspaceRoot);
  const globalDocuments = await loadExisting([
    ...(paths.managed === undefined ? [] : [{ layer: "managed" as const, path: paths.managed }]),
    { layer: "user" as const, path: paths.user },
  ], workspaceRoot);
  const trustedWorkspaces = await canonicalTrustedRoots(globalDocuments);
  const trust = await WorkspaceTrust.create({ workspaceRoot, trustedRoots: trustedWorkspaces });

  const projectFeature = trust.projectFeature("config");
  const projectCandidates = [
    { layer: "project" as const, path: paths.project },
    { layer: "local" as const, path: paths.local },
  ];
  const projectDocuments = projectFeature.enabled
    ? await loadExisting(projectCandidates, workspaceRoot, true)
    : [];
  const skippedFiles = projectFeature.enabled
    ? []
    : projectCandidates.map((candidate) => ({
        ...candidate,
        reason: projectFeature.reason ?? "Project configuration is disabled.",
      }));
  const documents = [...globalDocuments, ...projectDocuments];
  const preferences = mergePreferences(documents);
  const environmentOverrides = parseEnvironment(environment, cwd);
  const merged = mergeConfiguration(preferences, environmentOverrides);
  const rules = collectPermissionRules(documents);

  return {
    trust,
    ...(merged.provider === undefined ? {} : { provider: merged.provider }),
    ...(environmentOverrides.model === undefined ? {} : { model: environmentOverrides.model }),
    models: Object.freeze({ ...merged.models }),
    ...(merged.sessionDirectory === undefined ? {} : { sessionDirectory: merged.sessionDirectory }),
    trustedWorkspaces: Object.freeze([...trustedWorkspaces]),
    context: Object.freeze({ ...merged.context }),
    instructions: Object.freeze({ ...merged.instructions }),
    turn: Object.freeze({ ...merged.turn }),
    permissions: Object.freeze({
      ...(merged.permissions?.defaultDecision === undefined
        ? {}
        : { defaultDecision: merged.permissions.defaultDecision }),
      managedRules: Object.freeze(rules.managed),
      userRules: Object.freeze(rules.user),
      projectRules: Object.freeze(rules.project),
    }),
    mcpServers: Object.freeze({ ...merged.mcpServers }),
    hooks: freezeHooks(merged.hooks),
    skills: Object.freeze({ ...merged.skills }),
    loadedFiles: Object.freeze(documents.map(({ layer, path }) => ({ layer, path }))),
    skippedFiles: Object.freeze(skippedFiles),
  };
}

function resolvePaths(
  configured: ConfigurationPaths | undefined,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  workspaceRoot: string,
): { managed?: string; user: string; project: string; local: string } {
  const managed = configured?.managed ?? nonEmpty(environment.AGENT_CODE_MANAGED_CONFIG);
  const user = configured?.user ?? nonEmpty(environment.AGENT_CODE_USER_CONFIG) ??
    join(homedir(), ".agent-code", "config.json");
  return {
    ...(managed === undefined ? {} : { managed: resolveFrom(cwd, managed) }),
    user: resolveFrom(cwd, user),
    project: resolve(configured?.project ?? join(workspaceRoot, ".agent-code", "config.json")),
    local: resolve(configured?.local ?? join(workspaceRoot, ".agent-code", "config.local.json")),
  };
}

async function loadExisting(
  candidates: readonly { layer: ConfigurationLayer; path: string }[],
  workspaceRoot: string,
  projectOwned = false,
): Promise<LayerDocument[]> {
  const documents: LayerDocument[] = [];
  for (const candidate of candidates) {
    const document = await readConfiguration(candidate, workspaceRoot, projectOwned);
    if (document !== undefined) documents.push(document);
  }
  return documents;
}

async function readConfiguration(
  candidate: { layer: ConfigurationLayer; path: string },
  workspaceRoot: string,
  projectOwned: boolean,
): Promise<LayerDocument | undefined> {
  let content: string;
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate.path);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      throw new ConfigurationError(candidate.path, "$", "configuration path is not a regular file");
    }
    if (projectOwned && !isWithin(workspaceRoot, canonicalPath)) {
      throw new ConfigurationError(
        candidate.path,
        "$",
        "project configuration resolves outside the trusted workspace",
      );
    }
    content = await readFile(canonicalPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(candidate.path, "$", describeError(error), { cause: error });
  }

  let input: unknown;
  try {
    input = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ConfigurationError(candidate.path, "$", `invalid JSON: ${describeError(error)}`, {
      cause: error,
    });
  }
  const result = configurationSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigurationError(
      candidate.path,
      issue === undefined ? "$" : formatIssuePath(issue),
      issue?.message ?? "schema validation failed",
      { cause: result.error },
    );
  }
  if (candidate.layer === "project" || candidate.layer === "local") {
    const globalOnly = [
      ...(result.data.trustedWorkspaces === undefined ? [] : ["trustedWorkspaces"]),
      ...(result.data.sessionDirectory === undefined ? [] : ["sessionDirectory"]),
      ...(result.data.instructions?.userPath === undefined ? [] : ["instructions.userPath"]),
      ...(result.data.skills?.userDirectory === undefined ? [] : ["skills.userDirectory"]),
    ];
    const field = globalOnly[0];
    if (field !== undefined) {
      throw new ConfigurationError(
        candidate.path,
        field,
        "only managed and user configuration may set this global field",
      );
    }
  }
  return {
    ...candidate,
    path: canonicalPath,
    value: normalizePaths(result.data, dirname(canonicalPath)),
  };
}

function normalizePaths(value: Configuration, baseDirectory: string): Configuration {
  return {
    ...value,
    ...(value.sessionDirectory === undefined
      ? {}
      : { sessionDirectory: resolveFrom(baseDirectory, value.sessionDirectory) }),
    ...(value.trustedWorkspaces === undefined
      ? {}
      : { trustedWorkspaces: value.trustedWorkspaces.map((path) => resolveFrom(baseDirectory, path)) }),
    ...(value.instructions?.userPath === undefined
      ? {}
      : {
          instructions: {
            ...value.instructions,
            userPath: resolveFrom(baseDirectory, value.instructions.userPath),
          },
        }),
    ...(value.skills?.userDirectory === undefined
      ? {}
      : {
          skills: {
            ...value.skills,
            userDirectory: resolveFrom(baseDirectory, value.skills.userDirectory),
          },
        }),
  };
}

function mergePreferences(documents: readonly LayerDocument[]): Configuration {
  return documents.reduce<Configuration>(
    (merged, document) => mergeConfiguration(merged, document.value),
    {},
  );
}

function mergeConfiguration(base: Configuration, override: Configuration): Configuration {
  return {
    ...base,
    ...override,
    models: { ...base.models, ...override.models },
    context: { ...base.context, ...override.context },
    instructions: { ...base.instructions, ...override.instructions },
    turn: { ...base.turn, ...override.turn },
    permissions: { ...base.permissions, ...override.permissions },
    mcpServers: { ...base.mcpServers, ...override.mcpServers },
    hooks: mergeHooks(base.hooks, override.hooks),
    skills: { ...base.skills, ...override.skills },
    ...(base.trustedWorkspaces === undefined && override.trustedWorkspaces === undefined
      ? {}
      : {
          trustedWorkspaces: unique([
            ...(base.trustedWorkspaces ?? []),
            ...(override.trustedWorkspaces ?? []),
          ]),
        }),
  };
}

function mergeHooks(
  base: Configuration["hooks"],
  override: Configuration["hooks"],
): NonNullable<Configuration["hooks"]> {
  return Object.fromEntries(hookEventNames.flatMap((event) => {
    const commands = [...(base?.[event] ?? []), ...(override?.[event] ?? [])];
    return commands.length === 0 ? [] : [[event, commands]];
  })) as NonNullable<Configuration["hooks"]>;
}

function freezeHooks(
  hooks: Configuration["hooks"],
): Readonly<NonNullable<Configuration["hooks"]>> {
  return Object.freeze(Object.fromEntries(hookEventNames.flatMap((event) => {
    const commands = hooks?.[event];
    return commands === undefined ? [] : [[event, Object.freeze([...commands])]];
  })) as NonNullable<Configuration["hooks"]>);
}

function collectPermissionRules(documents: readonly LayerDocument[]): {
  managed: PermissionRule[];
  user: PermissionRule[];
  project: PermissionRule[];
} {
  const output = { managed: [] as PermissionRule[], user: [] as PermissionRule[], project: [] as PermissionRule[] };
  const ids = { managed: new Set<string>(), user: new Set<string>(), project: new Set<string>() };
  for (const document of documents) {
    const source = document.layer === "local" ? "project" : document.layer;
    const target = output[source];
    const known = ids[source];
    for (const rule of document.value.permissions?.rules ?? []) {
      if (known.has(rule.id)) {
        throw new ConfigurationError(
          document.path,
          "permissions.rules",
          `duplicate ${source} permission rule id: ${rule.id}`,
        );
      }
      known.add(rule.id);
      target.push(rule);
    }
  }
  return output;
}

function parseEnvironment(environment: NodeJS.ProcessEnv, cwd: string): Configuration & { model?: string } {
  const provider = nonEmpty(environment.AGENT_CODE_PROVIDER);
  if (provider !== undefined && provider !== "openai" && provider !== "deepseek") {
    throw new ConfigurationError(
      "environment",
      "AGENT_CODE_PROVIDER",
      "expected openai or deepseek",
    );
  }
  const contextTokens = positiveEnvironmentInteger(
    environment.AGENT_CODE_CONTEXT_TOKENS,
    "AGENT_CODE_CONTEXT_TOKENS",
  );
  const sessionDirectory = nonEmpty(environment.AGENT_CODE_SESSION_DIR);
  const model = nonEmpty(environment.AGENT_CODE_MODEL);
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sessionDirectory === undefined
      ? {}
      : { sessionDirectory: resolveFrom(cwd, sessionDirectory) }),
    ...(contextTokens === undefined ? {} : { context: { maxTokens: contextTokens } }),
  };
}

async function canonicalTrustedRoots(documents: readonly LayerDocument[]): Promise<string[]> {
  const roots: string[] = [];
  for (const document of documents) {
    for (const [index, path] of (document.value.trustedWorkspaces ?? []).entries()) {
      try {
        roots.push(await canonicalDirectory(path));
      } catch (error) {
        throw new ConfigurationError(
          document.path,
          `trustedWorkspaces[${index}]`,
          `trusted workspace must be an existing directory: ${describeError(error)}`,
          { cause: error },
        );
      }
    }
  }
  return unique(roots);
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new TypeError(`Not a directory: ${path}`);
  return canonical;
}

function formatIssuePath(issue: ZodIssue): string {
  if (issue.path.length === 0) return "$";
  return issue.path.reduce<string>((path, segment) =>
    typeof segment === "number"
      ? `${path}[${segment}]`
      : `${path}${path.length === 0 ? "" : "."}${String(segment)}`, "");
}

function positiveEnvironmentInteger(value: string | undefined, name: string): number | undefined {
  const normalized = nonEmpty(value);
  if (normalized === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new ConfigurationError("environment", name, "expected a positive integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigurationError("environment", name, "integer is outside the safe range");
  }
  return parsed;
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
