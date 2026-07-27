import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { JsonObject, JsonValue } from "../protocol/json.js";
import type { ToolSideEffect } from "../tools/tool.js";
import { isSensitiveFileName } from "../tools/files/policy.js";
import type { WorkspaceTrust } from "./trust.js";

export type PermissionDecision =
  | { readonly kind: "allow"; readonly scope: "once" | "session" }
  | { readonly kind: "ask"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string };

export type PermissionRuleAction = "allow" | "ask" | "deny";
export type PermissionRuleSource = "managed" | "user" | "project";

export interface PermissionRule {
  readonly id: string;
  readonly action: PermissionRuleAction;
  readonly tools?: readonly string[] | undefined;
  readonly sideEffects?: readonly ToolSideEffect[] | undefined;
  /** Exact resource or a prefix ending in `*`, for example `network:api.example.com`. */
  readonly resources?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly sideEffects: readonly ToolSideEffect[];
}

export interface NormalizedPermissionRequest extends PermissionRequest {
  readonly canonicalInput: string;
  readonly fingerprint: string;
  readonly resources: readonly string[];
}

export interface PermissionAuditEntry {
  readonly timestamp: string;
  readonly toolName: string;
  readonly fingerprint: string;
  readonly resources: readonly string[];
  readonly decision: "allow" | "deny";
  readonly scope?: "once" | "session" | undefined;
  readonly reason: string;
}

export type InteractivePermissionHandler = (
  request: NormalizedPermissionRequest,
  reason: string,
  signal: AbortSignal,
) => Promise<"allow_once" | "allow_session" | "deny">;

export type PermissionAuthorizationEvent =
  | {
      readonly type: "permission_requested";
      readonly request: NormalizedPermissionRequest;
      readonly reason: string;
    }
  | {
      readonly type: "permission_decided";
      readonly request: NormalizedPermissionRequest;
      readonly decision: "allow" | "deny";
      readonly scope?: "once" | "session" | undefined;
      readonly reason: string;
    };

export type PermissionAuthorizationObserver = (
  event: PermissionAuthorizationEvent,
) => void | Promise<void>;

/** Returns a reason to add a deny, or undefined to preserve the policy result. */
export type PermissionRequestGuard = (
  request: NormalizedPermissionRequest,
  reason: string,
  signal: AbortSignal,
) => string | undefined | Promise<string | undefined>;

export interface PermissionEngineOptions {
  readonly trust: WorkspaceTrust;
  readonly managedRules?: readonly PermissionRule[] | undefined;
  readonly userRules?: readonly PermissionRule[] | undefined;
  readonly projectRules?: readonly PermissionRule[] | undefined;
  readonly defaultDecision?: "allow" | "ask" | "deny" | undefined;
  readonly decide?: InteractivePermissionHandler | undefined;
  readonly now?: (() => Date) | undefined;
}

interface RuleMatch {
  readonly rule: PermissionRule;
  readonly source: PermissionRuleSource;
}

const BUILTIN_MANAGED_RULES: readonly PermissionRule[] = Object.freeze([
  Object.freeze({
    id: "protect-sensitive-paths",
    action: "deny",
    resources: Object.freeze(["sensitive:*"]),
    reason: "Sensitive credential paths are never exposed to tools.",
  }),
  Object.freeze({
    id: "keep-file-tools-in-workspace",
    action: "deny",
    tools: Object.freeze([
      "list_files",
      "search_text",
      "read_file",
      "apply_patch",
      "git_status",
      "git_diff",
      "git_log",
      "git_prepare_commit",
      "git_commit",
      "run_tests",
    ]),
    resources: Object.freeze(["external:*"]),
    reason: "Workspace file tools cannot access paths outside the workspace.",
  }),
]);

export class PermissionEngine {
  readonly #managedRules: readonly PermissionRule[];
  readonly #userRules: readonly PermissionRule[];
  readonly #projectRules: readonly PermissionRule[];
  readonly #projectRulesEnabled: boolean;
  readonly #defaultDecision: "allow" | "ask" | "deny";
  readonly #decide: InteractivePermissionHandler | undefined;
  readonly #now: () => Date;
  readonly #sessionGrants = new Set<string>();
  readonly #audit: PermissionAuditEntry[] = [];

  constructor(options: PermissionEngineOptions) {
    this.#managedRules = validateRules(
      [...BUILTIN_MANAGED_RULES, ...(options.managedRules ?? [])],
      "managed",
    );
    this.#userRules = validateRules(options.userRules ?? [], "user");
    this.#projectRulesEnabled = options.trust.projectFeature("permission_rules").enabled;
    // Untrusted project policy must not even be parsed: malformed project-owned
    // input should have no influence before trust is granted.
    this.#projectRules = this.#projectRulesEnabled
      ? validateRules(options.projectRules ?? [], "project")
      : Object.freeze([]);
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#decide = options.decide;
    this.#now = options.now ?? (() => new Date());
  }

  get auditLog(): readonly PermissionAuditEntry[] {
    return this.#audit.map((entry) => Object.freeze({
      ...entry,
      resources: Object.freeze([...entry.resources]),
    }));
  }

  clearSessionGrants(): void {
    this.#sessionGrants.clear();
  }

  async authorize(
    request: PermissionRequest,
    signal: AbortSignal,
    observe?: PermissionAuthorizationObserver,
    guard?: PermissionRequestGuard,
  ): Promise<PermissionDecision> {
    signal.throwIfAborted();
    const normalized = normalizePermissionRequest(request);
    const hardDeny = this.#findHardDeny(normalized);
    if (hardDeny !== undefined) {
      const reason = ruleReason(hardDeny);
      this.#record(normalized, "deny", reason);
      await observe?.({ type: "permission_decided", request: normalized, decision: "deny", reason });
      return { kind: "deny", reason };
    }

    if (this.#sessionGrants.has(normalized.fingerprint)) {
      const reason = "Allowed by an exact normalized session grant.";
      this.#record(normalized, "allow", reason, "session");
      await observe?.({ type: "permission_decided", request: normalized, decision: "allow", scope: "session", reason });
      return { kind: "allow", scope: "session" };
    }

    const explicitAsk = this.#findFirst(normalized, "ask");
    const explicitAllow = this.#findFirst(normalized, "allow");
    const initial: PermissionDecision = explicitAsk !== undefined
      ? { kind: "ask", reason: ruleReason(explicitAsk) }
      : explicitAllow !== undefined
        ? { kind: "allow", scope: "once" }
        : defaultPermission(this.#defaultDecision);

    if (initial.kind === "deny") {
      this.#record(normalized, "deny", initial.reason);
      await observe?.({ type: "permission_decided", request: normalized, decision: "deny", reason: initial.reason });
      return initial;
    }
    if (initial.kind === "allow") {
      const reason = explicitAllow === undefined ? "Allowed by default policy." : ruleReason(explicitAllow);
      this.#record(normalized, "allow", reason, initial.scope);
      await observe?.({ type: "permission_decided", request: normalized, decision: "allow", scope: initial.scope, reason });
      return initial;
    }

    if (this.#decide === undefined) {
      const reason = `${initial.reason} No interactive permission handler is available; denied safely.`;
      this.#record(normalized, "deny", reason);
      await observe?.({ type: "permission_decided", request: normalized, decision: "deny", reason });
      return { kind: "deny", reason };
    }

    await observe?.({ type: "permission_requested", request: normalized, reason: initial.reason });
    const guardedReason = await guard?.(normalized, initial.reason, signal);
    signal.throwIfAborted();
    if (guardedReason !== undefined) {
      const reason = `PermissionRequest hook denied the request: ${guardedReason}`;
      this.#record(normalized, "deny", reason);
      await observe?.({ type: "permission_decided", request: normalized, decision: "deny", reason });
      return { kind: "deny", reason };
    }
    const answer = await this.#decide(normalized, initial.reason, signal);
    signal.throwIfAborted();
    if (answer === "deny") {
      const reason = `User denied the request: ${initial.reason}`;
      this.#record(normalized, "deny", reason);
      await observe?.({ type: "permission_decided", request: normalized, decision: "deny", reason });
      return { kind: "deny", reason };
    }
    const scope = answer === "allow_session" ? "session" : "once";
    if (scope === "session") this.#sessionGrants.add(normalized.fingerprint);
    this.#record(normalized, "allow", initial.reason, scope);
    await observe?.({ type: "permission_decided", request: normalized, decision: "allow", scope, reason: initial.reason });
    return { kind: "allow", scope };
  }

  #findHardDeny(request: NormalizedPermissionRequest): RuleMatch | undefined {
    for (const [source, rules] of this.#layers()) {
      const rule = rules.find((candidate) => candidate.action === "deny" && matches(candidate, request));
      if (rule !== undefined) return { rule, source };
    }
    return undefined;
  }

  #findFirst(
    request: NormalizedPermissionRequest,
    action: "ask" | "allow",
  ): RuleMatch | undefined {
    for (const [source, rules] of this.#layers()) {
      const rule = rules.find((candidate) => candidate.action === action && matches(candidate, request));
      if (rule !== undefined) return { rule, source };
    }
    return undefined;
  }

  #layers(): readonly (readonly [PermissionRuleSource, readonly PermissionRule[]])[] {
    return [
      ["managed", this.#managedRules],
      ["user", this.#userRules],
      ["project", this.#projectRulesEnabled ? this.#projectRules : []],
    ];
  }

  #record(
    request: NormalizedPermissionRequest,
    decision: "allow" | "deny",
    reason: string,
    scope?: "once" | "session",
  ): void {
    this.#audit.push(Object.freeze({
      timestamp: this.#now().toISOString(),
      toolName: request.toolName,
      fingerprint: request.fingerprint,
      resources: Object.freeze([...request.resources]),
      decision,
      ...(scope === undefined ? {} : { scope }),
      reason,
    }));
  }
}

export function normalizePermissionRequest(
  request: PermissionRequest,
): NormalizedPermissionRequest {
  const input = structuredClone(request.input);
  freezeJson(input);
  const canonicalInput = canonicalJson(input);
  const resources = discoverResources(input, request.sideEffects);
  const signature = canonicalJson({
    toolName: request.toolName,
    input,
    sideEffects: [...request.sideEffects].sort(),
    resources,
  });
  return Object.freeze({
    toolName: request.toolName,
    input,
    sideEffects: Object.freeze([...request.sideEffects]),
    canonicalInput,
    fingerprint: createHash("sha256").update(signature).digest("hex"),
    resources: Object.freeze(resources),
  });
}

function discoverResources(
  input: JsonObject,
  sideEffects: readonly ToolSideEffect[],
): string[] {
  const resources = new Set<string>();
  for (const effect of sideEffects) resources.add(`effect:${effect}`);
  if (sideEffects.includes("network")) resources.add("network:*");

  visitJson(input, (key, value) => {
    if (typeof value !== "string") return;
    if (key === "path" || key === "paths" || key === "cwd") addPathResources(resources, value);
    for (const match of value.matchAll(/https?:\/\/([^\s/'"`]+)/giu)) {
      const host = match[1]?.split(":", 1)[0]?.toLowerCase();
      if (host !== undefined && host.length > 0) resources.add(`network:${host}`);
    }
  });
  return [...resources].sort();
}

function addPathResources(resources: Set<string>, input: string): void {
  const value = input.replaceAll("\\", "/");
  const normalized = posix.normalize(value || ".");
  if (
    value.includes("\0") ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(input) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    resources.add(`external:${value}`);
  } else {
    resources.add(`workspace:${normalized}`);
  }
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  const name = segments.at(-1);
  if (
    segments.some((segment) => [".ssh", ".aws", ".gnupg", ".azure", "gcloud"].includes(segment)) ||
    (name !== undefined && isSensitiveFileName(name))
  ) {
    resources.add(`sensitive:${normalized}`);
  }
}

function visitJson(
  value: JsonValue,
  visit: (key: string, value: JsonValue) => void,
  key = "",
): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const child of value) visitJson(child, visit, key);
  } else if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) visitJson(child, visit, childKey);
  }
}

function matches(rule: PermissionRule, request: NormalizedPermissionRequest): boolean {
  if (rule.tools !== undefined && !rule.tools.includes(request.toolName)) return false;
  if (
    rule.sideEffects !== undefined &&
    !rule.sideEffects.some((effect) => request.sideEffects.includes(effect))
  ) return false;
  if (
    rule.resources !== undefined &&
    !rule.resources.some((pattern) => request.resources.some((resource) => resourceMatches(pattern, resource)))
  ) return false;
  return true;
}

function resourceMatches(pattern: string, resource: string): boolean {
  return pattern.endsWith("*")
    ? resource.startsWith(pattern.slice(0, -1))
    : resource === pattern;
}

function ruleReason(match: RuleMatch): string {
  return `${match.source} rule ${match.rule.id}: ${match.rule.reason ?? match.rule.action}`;
}

function defaultPermission(action: "allow" | "ask" | "deny"): PermissionDecision {
  if (action === "allow") return { kind: "allow", scope: "once" };
  if (action === "deny") return { kind: "deny", reason: "Denied by default policy." };
  return { kind: "ask", reason: "No explicit rule matched; confirmation is required by default policy." };
}

function validateRules(
  rules: readonly PermissionRule[],
  source: PermissionRuleSource,
): readonly PermissionRule[] {
  const ids = new Set<string>();
  return Object.freeze(rules.map((rule) => {
    if (rule.id.trim().length === 0) throw new TypeError(`${source} rule id must not be empty`);
    if (ids.has(rule.id)) throw new TypeError(`Duplicate ${source} rule id: ${rule.id}`);
    ids.add(rule.id);
    for (const pattern of rule.resources ?? []) {
      if (pattern.length === 0 || pattern.slice(0, -1).includes("*")) {
        throw new TypeError(`Invalid resource pattern in ${source} rule ${rule.id}`);
      }
    }
    return Object.freeze({
      ...rule,
      ...(rule.tools === undefined ? {} : { tools: Object.freeze([...rule.tools]) }),
      ...(rule.sideEffects === undefined ? {} : { sideEffects: Object.freeze([...rule.sideEffects]) }),
      ...(rule.resources === undefined ? {} : { resources: Object.freeze([...rule.resources]) }),
    });
  }));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function freezeJson(value: JsonValue): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
