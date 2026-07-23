import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { WorkspaceTrust } from "../security/trust.js";
import type { Tool } from "../tools/tool.js";

export const SKILL_FILE_NAME = "SKILL.md";
export const DEFAULT_MAX_SKILL_FILE_BYTES = 64 * 1024;

export interface SkillDescriptor {
  readonly name: string;
  readonly source: "user" | "project";
  readonly path: string;
}

export interface LoadedSkill extends SkillDescriptor {
  readonly content: string;
}

export interface SkillCatalogOptions {
  readonly workspaceRoot: string;
  readonly trust: WorkspaceTrust;
  readonly userDirectory?: string | undefined;
  readonly maxFileBytes?: number | undefined;
}

/**
 * Publishes Skill metadata without eagerly injecting Skill contents. The model
 * can load a listed workflow through one host-owned loader tool, so the read is
 * still visible to the permission and audit pipeline. Individual Skills never
 * become tools and sibling scripts are never executed by the loader.
 */
export class SkillCatalog {
  readonly #skills: ReadonlyMap<string, SkillDescriptor>;
  readonly #maxFileBytes: number;

  private constructor(skills: ReadonlyMap<string, SkillDescriptor>, maxFileBytes: number) {
    this.#skills = skills;
    this.#maxFileBytes = maxFileBytes;
  }

  static async create(options: SkillCatalogOptions): Promise<SkillCatalog> {
    const maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
      "maxFileBytes",
    );
    const workspaceRoot = await canonicalDirectory(options.workspaceRoot);
    const userDirectory = resolve(
      options.userDirectory ?? join(homedir(), ".agent-code", "skills"),
    );
    const descriptors = [
      ...await discoverDirectory(userDirectory, "user", maxFileBytes),
      ...(options.trust.projectFeature("skills").enabled
        ? await discoverDirectory(
            join(workspaceRoot, ".agent-code", "skills"),
            "project",
            maxFileBytes,
            workspaceRoot,
          )
        : []),
    ];
    const skills = new Map<string, SkillDescriptor>();
    for (const descriptor of descriptors) {
      // A trusted project may intentionally shadow a global workflow.
      skills.set(descriptor.name, Object.freeze(descriptor));
    }
    return new SkillCatalog(skills, maxFileBytes);
  }

  get entries(): readonly SkillDescriptor[] {
    return Object.freeze([...this.#skills.values()]);
  }

  renderCatalog(): string | undefined {
    if (this.#skills.size === 0) return undefined;
    return [
      "[Available Skills — metadata only]",
      "Skills are optional instruction workflows, not extra authority or automatically executed tools.",
      "Load a relevant workflow on demand with load_skill. Scripts beside SKILL.md are ordinary files and may run only through permission-checked process tools.",
      ...[...this.#skills.values()].map(
        (skill) => `- ${skill.name} (${skill.source}): ${skill.path}`,
      ),
      "[End available Skills]",
    ].join("\n");
  }

  async load(name: string): Promise<LoadedSkill> {
    const skill = this.#skills.get(name);
    if (skill === undefined) throw new Error(`Unknown Skill: ${name}`);
    const content = await readBoundedUtf8(skill.path, this.#maxFileBytes);
    return Object.freeze({ ...skill, content });
  }
}

export function createSkillLoaderTool(catalog: SkillCatalog): Tool | undefined {
  const names = catalog.entries.map(({ name }) => name);
  if (names.length === 0) return undefined;
  return {
    definition: {
      name: "load_skill",
      description: "Load one configured Skill workflow on demand. A Skill supplies instructions only and never grants permission or executes sibling scripts.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", enum: names },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    sideEffects: ["read_workspace"],
    handler: async (input) => {
      const name = input.name;
      if (typeof name !== "string") throw new TypeError("Skill name must be a string");
      const loaded = await catalog.load(name);
      return {
        content: [
          `[Loaded Skill "${loaded.name}" from ${loaded.source} configuration]`,
          "This workflow is instruction context only; it cannot grant tool permission or weaken the sandbox.",
          loaded.content,
          `[End Skill "${loaded.name}"]`,
        ].join("\n"),
        data: {
          name: loaded.name,
          source: loaded.source,
          path: loaded.path,
        },
      };
    },
  };
}

async function discoverDirectory(
  directory: string,
  source: SkillDescriptor["source"],
  maxFileBytes: number,
  workspaceRoot?: string,
): Promise<SkillDescriptor[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const skills: SkillDescriptor[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/u.test(entry.name)) continue;
    const configuredPath = join(directory, entry.name, SKILL_FILE_NAME);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(configuredPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (workspaceRoot !== undefined && !isWithin(workspaceRoot, canonicalPath)) {
      throw new Error(`Project Skill resolves outside the trusted workspace: ${configuredPath}`);
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw new Error(`Skill path is not a regular file: ${configuredPath}`);
    if (metadata.size > maxFileBytes) {
      throw new Error(`Skill file exceeds the ${maxFileBytes}-byte limit: ${configuredPath}`);
    }
    skills.push({ name: entry.name, source, path: canonicalPath });
  }
  return skills;
}

async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Skill path is not a regular file: ${path}`);
  if (metadata.size > maxBytes) throw new Error(`Skill file exceeds the ${maxBytes}-byte limit: ${path}`);
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) throw new Error(`Skill file exceeds the ${maxBytes}-byte limit: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch (error) {
    throw new Error(`Skill file is not valid UTF-8: ${path}`, { cause: error });
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new TypeError(`Not a directory: ${path}`);
  return canonical;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
