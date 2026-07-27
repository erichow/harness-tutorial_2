import type { LoadedConfiguration } from "../config/loader.js";
import { PluginCatalog } from "../extensions/plugin.js";
import { RemoteAuditExporter } from "../observability/exporter.js";

export type TeamHostKind = "cli" | "ide" | "websocket";

export function assertHostAllowed(
  configuration: Pick<LoadedConfiguration, "teamPolicy">,
  kind: TeamHostKind,
): void {
  const allowed = configuration.teamPolicy.hosts?.allowedKinds;
  if (allowed !== undefined && !allowed.includes(kind)) {
    throw new Error(`Host ${kind} is disabled by managed team policy`);
  }
}

export function createManagedPluginCatalog(
  configuration: Pick<LoadedConfiguration, "teamPolicy">,
): PluginCatalog {
  return new PluginCatalog({
    allowedIds: configuration.teamPolicy.plugins?.allowedIds,
    deniedCapabilities: configuration.teamPolicy.plugins?.deniedCapabilities,
  });
}

export function createManagedAuditExporter(options: {
  readonly configuration: Pick<LoadedConfiguration, "teamPolicy">;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly diagnostic?: ((message: string) => void) | undefined;
  readonly fetch?: typeof fetch | undefined;
}): RemoteAuditExporter | undefined {
  const audit = options.configuration.teamPolicy.audit;
  if (audit === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const [header, environmentName] of Object.entries(audit.headersFrom ?? {})) {
    const value = options.environment[environmentName]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(
        `Managed audit header ${header} requires environment variable ${environmentName}`,
      );
    }
    headers[header] = value;
  }
  return new RemoteAuditExporter({
    endpoint: audit.endpoint,
    sessionId: options.sessionId,
    headers,
    ...(audit.timeoutMs === undefined ? {} : { timeoutMs: audit.timeoutMs }),
    ...(audit.failureMode === undefined ? {} : { failureMode: audit.failureMode }),
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
