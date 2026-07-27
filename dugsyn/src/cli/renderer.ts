import type { JsonValue } from "../protocol/json.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { NormalizedPermissionRequest } from "../security/permissions.js";

export interface TerminalOutput {
  write(chunk: string): unknown;
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
}

export interface TerminalRendererOptions {
  readonly output: TerminalOutput;
  readonly useColor?: boolean | undefined;
}

/** Host-neutral rendering boundary used by the interactive CLI. */
export interface RuntimeRenderer {
  render(event: RuntimeEvent): void;
  notice(message: string): void;
  finish(): void;
}

type StreamKind = "text" | "summary";
type DeferredOutput =
  | { readonly kind: "event"; readonly event: RuntimeEvent }
  | { readonly kind: "notice"; readonly message: string };

/** A single state machine renders model, tool, and permission activity. */
export class TerminalRenderer implements RuntimeRenderer {
  readonly #output: TerminalOutput;
  readonly #useColor: boolean;
  readonly #toolNames = new Map<string, string>();
  readonly #deferred: DeferredOutput[] = [];
  #streamKind: StreamKind | undefined;
  #permissionActive = false;
  #announcedPermissionRequest: string | undefined;

  constructor(options: TerminalRendererOptions) {
    this.#output = options.output;
    this.#useColor = options.useColor ?? options.output.isTTY === true;
  }

  render(event: RuntimeEvent): void {
    if (this.#permissionActive) {
      this.#deferred.push({ kind: "event", event });
      return;
    }
    this.#renderNow(event);
  }

  notice(message: string): void {
    if (this.#permissionActive) {
      this.#deferred.push({ kind: "notice", message });
      return;
    }
    this.#noticeNow(message);
  }

  permissionNotice(message: string): void {
    if (!this.#permissionActive) throw new Error("No permission prompt is active");
    this.#noticeNow(message);
  }

  #noticeNow(message: string): void {
    this.#endStream();
    for (const line of message.split(/\r?\n/u)) this.#writeLine(line);
  }

  beginPermission(request: NormalizedPermissionRequest, reason: string): string {
    if (this.#permissionActive) throw new Error("A permission prompt is already active");
    this.#endStream();
    this.#permissionActive = true;
    if (this.#announcedPermissionRequest !== request.fingerprint) {
      this.#writeStatus("?", "yellow", `Permission requested by ${request.toolName}`);
    }
    this.#announcedPermissionRequest = undefined;
    this.#writeLine(`  Resources: ${request.resources.join(", ") || "none"}`);
    this.#writeLine(`  Reason: ${reason}`);
    const detail = permissionDetail(request);
    if (detail !== undefined) this.#writeLine(`  Request: ${detail}`);
    return "Allow? [y] once / [a] session / [n] deny: ";
  }

  endPermission(outcome: "allow_once" | "allow_session" | "deny" | "cancelled"): void {
    if (!this.#permissionActive) return;
    this.#permissionActive = false;
    const label = outcome === "allow_once"
      ? "Allowed once"
      : outcome === "allow_session"
        ? "Allowed for this exact request in this session"
        : outcome === "deny"
          ? "Denied"
          : "Permission prompt cancelled";
    this.#writeLine(label);
    const deferred = this.#deferred.splice(0);
    for (const item of deferred) {
      if (item.kind === "event") this.#renderNow(item.event);
      else this.#noticeNow(item.message);
    }
  }

  finish(): void {
    this.#endStream();
  }

  #renderNow(event: RuntimeEvent): void {
    switch (event.type) {
      case "turn_started":
      case "usage":
      case "provider_request_started":
      case "provider_response":
        return;
      case "text_delta":
        this.#stream("text", event.delta);
        return;
      case "reasoning_summary_delta":
        this.#stream("summary", event.delta);
        return;
      case "tool_call_started": {
        this.#endStream();
        this.#toolNames.set(event.call.id, event.call.name);
        const detail = toolDetail(event.call.input);
        this.#writeStatus("→", "cyan", `${event.call.name}${detail === undefined ? "" : ` ${detail}`}`);
        return;
      }
      case "tool_call_finished": {
        this.#endStream();
        const name = this.#toolNames.get(event.result.toolCallId) ?? event.result.toolCallId;
        const ok = event.result.status === "success";
        let detail = ok ? resultDetail(event.result.data) : errorLabel(event.result.error?.code);
        // For execution failures, show the first line of the error so the model knows why
        if (!ok && detail === "(failed)" && event.result.content) {
          const firstLine = event.result.content.split("\n")[0]?.trim() ?? "";
          if (firstLine.length > 0) {
            const snippet = firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57) + "…";
            detail = `(failed: ${snippet})`;
          }
        }
        this.#writeStatus(ok ? "✓" : "✗", ok ? "green" : "red", `${name}${detail === undefined ? "" : ` ${detail}`}`);
        return;
      }
      case "permission_requested":
        this.#endStream();
        this.#announcedPermissionRequest = event.requestId;
        this.#writeStatus("?", "yellow", `Permission requested by ${event.toolName}: ${event.reason}`);
        return;
      case "permission_decided":
        return;
      case "error":
        this.#endStream();
        this.#writeStatus("!", event.category === "cancelled" ? "yellow" : "red", event.message);
        return;
      case "turn_finished":
        this.#endStream();
        if (event.reason === "max_steps") this.#writeLine("Turn stopped: maximum steps reached.");
        if (event.reason === "max_duration") this.#writeLine("Turn stopped: maximum duration reached.");
        if (event.reason === "max_tokens") this.#writeLine("Turn stopped: token budget reached.");
        if (event.tests !== undefined && event.tests.runs > 0) {
          const detail = event.tests.status === "not_run"
            ? event.tests.runs === 0
              ? "not run"
              : `not run after latest changes (${event.tests.runs} earlier run${event.tests.runs === 1 ? "" : "s"})`
            : event.tests.status === "passed"
              ? `passed (${event.tests.runs} run${event.tests.runs === 1 ? "" : "s"})`
              : `failed (${event.tests.lastOutcome ?? "failed"})`;
          this.#writeLine(`Tests: ${detail}.`);
        }
        return;
    }
  }

  #stream(kind: StreamKind, value: string): void {
    if (this.#streamKind !== kind) {
      this.#endStream();
      this.#output.write(kind === "summary" ? this.#style("· ", "dim") : "");
      this.#streamKind = kind;
    }
    this.#output.write(sanitizeTerminalText(value));
  }

  #endStream(): void {
    if (this.#streamKind === undefined) return;
    this.#output.write("\n");
    this.#streamKind = undefined;
  }

  #writeLine(value: string): void {
    const width = Math.max(20, this.#output.columns ?? 100);
    this.#output.write(`${truncateLine(sanitizeTerminalText(value), width)}\n`);
  }

  #writeStatus(
    marker: string,
    color: "cyan" | "green" | "red" | "yellow",
    message: string,
  ): void {
    const width = Math.max(20, this.#output.columns ?? 100);
    const line = truncateLine(`${marker} ${sanitizeTerminalText(message)}`, width);
    const rendered = this.#useColor
      ? `${this.#style(marker, color)}${line.slice(marker.length)}`
      : line;
    this.#output.write(`${rendered}\n`);
  }

  #style(value: string, color: "cyan" | "green" | "red" | "yellow" | "dim"): string {
    if (!this.#useColor) return value;
    const code = color === "cyan" ? 36 : color === "green" ? 32 : color === "red" ? 31 : color === "yellow" ? 33 : 2;
    return `\u001b[${code}m${value}\u001b[0m`;
  }
}

/** Remove terminal control sequences while preserving ordinary newlines and tabs. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

function truncateLine(value: string, columns: number): string {
  const oneLine = value.replaceAll("\n", " ");
  const characters = [...oneLine];
  return characters.length <= columns ? oneLine : `${characters.slice(0, columns - 1).join("")}…`;
}

function toolDetail(input: Readonly<Record<string, JsonValue>>): string | undefined {
  for (const key of ["path", "query", "cwd", "jobId", "command"] as const) {
    const value = input[key];
    if (typeof value === "string") return truncateLine(JSON.stringify(value), 60);
  }
  return undefined;

}

function resultDetail(data: JsonValue | undefined): string | undefined {
  if (!isObject(data)) return undefined;
  if (typeof data.operation === "string" && typeof data.path === "string") {
    return `(${data.operation} ${data.path})`;
  }
  if (typeof data.exitCode === "number") return `(exit ${data.exitCode})`;
  if (typeof data.status === "string") return `(${data.status})`;
  if (typeof data.startLine === "number" && typeof data.endLine === "number") {
    const range = data.startLine === data.endLine
      ? `L${data.startLine}`
      : `L${data.startLine}-${data.endLine}`;
    if (typeof data.totalLines === "number") return `(${range}/${data.totalLines})`;
    return `(${range})`;
  }
  if (typeof data.fileCount === "number" && typeof data.dirCount === "number") {
    const limit = data.entryLimitReached === true ? "+" : "";
    return `(${data.fileCount} files, ${data.dirCount} dirs${limit})`;
  }
  if (typeof data.kind === "string" && typeof data.exists === "boolean") {
    if (!data.exists) return "(not found)";
    const label = data.path !== undefined && data.path !== "." ? `${data.kind} ${data.path}` : String(data.kind);
    const sizeStr = typeof data.size === "number" ? `, ${fmtSize(data.size)}` : "";
    return `(${label}${sizeStr})`;
  }

  return undefined;
}
function permissionDetail(request: NormalizedPermissionRequest): string | undefined {
  return toolDetail(request.input);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function errorLabel(code: string | undefined): string | undefined {
  if (code === "permission_denied") return "(denied)";
  if (code === "repeated_call") return "(repeated)";
  if (code === "limit_reached") return "(limit)";
  if (code === "execution_failed") return "(failed)";
  if (code === "invalid_arguments") return "(bad args)";
  if (code === "unknown_tool") return "(unknown)";
  return undefined;
}
