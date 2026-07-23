const READ_ONLY_TOOLS = new Set([
  "list_files",
  "search_text",
  "read_file",
  "git_status",
  "git_diff",
  "git_log",
]);

const COORDINATOR_OWNED_TOOLS = new Set([
  "git_prepare_commit",
  "git_commit",
]);

export interface SubagentCapabilityGrant {
  readonly tools: readonly string[];
}

export interface EffectiveSubagentCapabilities {
  readonly tools: readonly string[];
}

/**
 * Child capabilities are an attenuation of an explicit parent-task grant.
 * Missing capabilities are rejected instead of silently producing a weaker,
 * surprising task.
 */
export function attenuateSubagentCapabilities(
  parent: SubagentCapabilityGrant,
  requestedTools: readonly string[],
  mode: "read" | "write",
): EffectiveSubagentCapabilities {
  const parentTools = uniqueNonEmpty(parent.tools, "parent capability");
  const requested = [...uniqueNonEmpty(requestedTools, "requested capability")];
  const unavailable = requested.filter((name) => !parentTools.has(name));
  if (unavailable.length > 0) {
    throw new TypeError(
      `Subagent requested capabilities not granted by parent: ${unavailable.sort().join(", ")}`,
    );
  }
  const coordinatorOwned = requested.filter((name) => COORDINATOR_OWNED_TOOLS.has(name));
  if (coordinatorOwned.length > 0) {
    throw new TypeError(
      `Subagent cannot control coordinator-owned Git tools: ${coordinatorOwned.sort().join(", ")}`,
    );
  }
  if (mode === "read") {
    const writeCapable = requested.filter((name) => !READ_ONLY_TOOLS.has(name));
    if (writeCapable.length > 0) {
      throw new TypeError(
        `Read-only subagent requested write-capable tools: ${writeCapable.sort().join(", ")}`,
      );
    }
  }
  return Object.freeze({ tools: Object.freeze(requested.sort()) });
}

function uniqueNonEmpty(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (value.trim().length === 0) throw new TypeError(`${label} name must not be empty`);
    if (result.has(value)) throw new TypeError(`Duplicate ${label}: ${value}`);
    result.add(value);
  }
  return result;
}
