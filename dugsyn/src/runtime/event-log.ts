import type { JsonValue } from "../protocol/json.js";
import { runtimeEventSchema } from "./event-schemas.js";
import type { RuntimeEvent } from "./events.js";

export interface LoggedFileChange {
  readonly turnId: string;
  readonly sequence: number;
  readonly toolCallId: string;
  readonly operation: "add" | "update" | "delete";
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface TurnFileChanges {
  readonly turnId: string;
  readonly files: readonly string[];
  readonly changes: readonly LoggedFileChange[];
  readonly additions: number;
  readonly deletions: number;
}

interface TurnLogState {
  nextSequence: number;
  finished: boolean;
}

/** Validated, append-only runtime events for deterministic replay and auditing. */
export class RuntimeEventLog {
  readonly #entries: RuntimeEvent[] = [];
  readonly #turns = new Map<string, TurnLogState>();

  append(event: RuntimeEvent): void {
    const parsed = runtimeEventSchema.parse(event) as RuntimeEvent;
    const state = this.#turns.get(parsed.turnId);
    if (state === undefined) {
      if (parsed.type !== "turn_started" || parsed.sequence !== 0) {
        throw new Error(`Turn ${parsed.turnId} must begin with turn_started sequence 0`);
      }
      this.#turns.set(parsed.turnId, {
        nextSequence: 1,
        finished: false,
      });
    } else {
      if (state.finished) throw new Error(`Turn ${parsed.turnId} already finished`);
      if (parsed.sequence !== state.nextSequence) {
        throw new Error(
          `Turn ${parsed.turnId} expected sequence ${state.nextSequence}, received ${parsed.sequence}`,
        );
      }
      state.nextSequence += 1;
      if (parsed.type === "turn_finished") state.finished = true;
    }
    this.#entries.push(deepFreeze(parsed));
  }

  get entries(): readonly RuntimeEvent[] {
    return Object.freeze([...this.#entries]);
  }

  get permissionDecisions(): readonly Extract<RuntimeEvent, { type: "permission_decided" }>[] {
    return Object.freeze(this.#entries.filter(
      (event): event is Extract<RuntimeEvent, { type: "permission_decided" }> =>
        event.type === "permission_decided",
    ));
  }

  get fileChanges(): readonly LoggedFileChange[] {
    const changes: LoggedFileChange[] = [];
    for (const event of this.#entries) {
      if (event.type !== "tool_call_finished" || event.result.status !== "success") continue;
      const data = event.result.data;
      if (!isObject(data)) continue;
      const operation = data.operation;
      const path = data.path;
      const beforeHash = data.beforeHash;
      const afterHash = data.afterHash;
      const diff = data.diff;
      const additions = data.additions;
      const deletions = data.deletions;
      if (
        (operation !== "add" && operation !== "update" && operation !== "delete") ||
        typeof path !== "string" ||
        !isHashOrNull(beforeHash) ||
        !isHashOrNull(afterHash) ||
        typeof diff !== "string" ||
        !isNonnegativeInteger(additions) ||
        !isNonnegativeInteger(deletions)
      ) continue;
      changes.push(Object.freeze({
        turnId: event.turnId,
        sequence: event.sequence,
        toolCallId: event.result.toolCallId,
        operation,
        path,
        beforeHash,
        afterHash,
        diff,
        additions,
        deletions,
      }));
    }
    return Object.freeze(changes);
  }

  /** Summarize the files and line-level diffs produced by one agent turn. */
  changesForTurn(turnId: string): TurnFileChanges {
    const changes = this.fileChanges.filter((change) => change.turnId === turnId);
    return Object.freeze({
      turnId,
      files: Object.freeze([...new Set(changes.map((change) => change.path))]),
      changes: Object.freeze(changes),
      additions: changes.reduce((total, change) => total + change.additions, 0),
      deletions: changes.reduce((total, change) => total + change.deletions, 0),
    });
  }

  toJSONLines(): string {
    return this.#entries.map((event) => JSON.stringify(event)).join("\n");
  }
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHashOrNull(value: JsonValue | undefined): value is string | null {
  return value === null || (typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function isNonnegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
