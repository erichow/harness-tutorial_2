import { isAbsolute, posix } from "node:path";

import { z } from "zod";

export const PLUGIN_API_VERSION = 1 as const;

export const pluginCapabilitySchema = z.enum([
  "renderer",
  "ide_transport",
  "websocket_transport",
  "tool",
  "provider",
  "event_exporter",
]);

const relativeEntrypointSchema = z.string().trim().min(1).refine((value) => {
  if (isAbsolute(value) || value.includes("\\")) return false;
  const normalized = posix.normalize(value);
  return normalized !== ".." && !normalized.startsWith("../");
}, {
  message: "entrypoint must be a portable relative path inside the plugin",
});

export const pluginManifestSchema = z.object({
  apiVersion: z.literal(PLUGIN_API_VERSION),
  id: z.string().trim().regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u,
    "id must be a lowercase, namespaced identifier",
  ),
  name: z.string().trim().min(1),
  version: z.string().trim().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u),
  entrypoint: relativeEntrypointSchema,
  capabilities: z.array(pluginCapabilitySchema).min(1),
}).strict();

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
type ParsedPluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifest = Omit<ParsedPluginManifest, "capabilities"> & {
  readonly capabilities: readonly PluginCapability[];
};

export interface ManagedPluginPolicy {
  readonly allowedIds?: readonly string[] | undefined;
  readonly deniedCapabilities?: readonly PluginCapability[] | undefined;
}

/**
 * Validates discovery metadata without importing plugin code. Loading arbitrary
 * JavaScript is deliberately left to a trusted host after policy approval.
 */
export class PluginCatalog {
  readonly #manifests = new Map<string, PluginManifest>();
  readonly #allowedIds: ReadonlySet<string> | undefined;
  readonly #deniedCapabilities: ReadonlySet<PluginCapability>;

  constructor(policy: ManagedPluginPolicy = {}) {
    this.#allowedIds = policy.allowedIds === undefined
      ? undefined
      : new Set(policy.allowedIds);
    this.#deniedCapabilities = new Set(policy.deniedCapabilities ?? []);
  }

  add(input: unknown): PluginManifest {
    const manifest = pluginManifestSchema.parse(input);
    if (this.#manifests.has(manifest.id)) {
      throw new Error(`Duplicate plugin id: ${manifest.id}`);
    }
    if (this.#allowedIds !== undefined && !this.#allowedIds.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} is not allowed by managed policy`);
    }
    const denied = manifest.capabilities.find(
      (capability) => this.#deniedCapabilities.has(capability),
    );
    if (denied !== undefined) {
      throw new Error(
        `Plugin ${manifest.id} requests denied capability: ${denied}`,
      );
    }
    const frozen: PluginManifest = Object.freeze({
      ...manifest,
      capabilities: Object.freeze([...new Set(manifest.capabilities)]),
    });
    this.#manifests.set(frozen.id, frozen);
    return frozen;
  }

  get manifests(): readonly PluginManifest[] {
    return Object.freeze([...this.#manifests.values()]);
  }
}
