import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { transcriptMessageSchema } from "../messages/schemas.js";
import {
  createTranscript,
  type Transcript,
  type TranscriptMessage,
} from "../messages/transcript.js";
import { runtimeEventSchema } from "../runtime/event-schemas.js";
import type { RuntimeEvent } from "../runtime/events.js";

export const SESSION_SCHEMA_VERSION = 1 as const;
export const SESSION_RECORD_SCHEMA_VERSION = 1 as const;

export interface SessionMetadata {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly name: string;
  readonly projectPath: string;
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSessionId?: string | undefined;
}

export interface SessionSnapshot {
  readonly metadata: SessionMetadata;
  readonly transcript: Transcript;
  readonly events: readonly RuntimeEvent[];
}

export interface CreateSessionOptions {
  readonly sessionId?: string | undefined;
  readonly name?: string | undefined;
  readonly projectPath: string;
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly parentSessionId?: string | undefined;
  readonly transcript?: Transcript | undefined;
}

export interface ForkSessionOptions {
  readonly sessionId?: string | undefined;
  readonly name?: string | undefined;
  readonly projectPath?: string | undefined;
  readonly provider?: "openai" | "deepseek" | undefined;
  readonly model?: string | undefined;
}

export interface SessionStoreOptions {
  readonly rootDirectory: string;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
  readonly processId?: number | undefined;
  readonly hostName?: string | undefined;
}

interface TranscriptMessageRecord {
  readonly schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
  readonly type: "message";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly message: TranscriptMessage;
}

interface TranscriptResetRecord {
  readonly schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
  readonly type: "reset";
  readonly sequence: number;
  readonly recordedAt: string;
}

type TranscriptRecord = TranscriptMessageRecord | TranscriptResetRecord;

interface EventRecord {
  readonly schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
  readonly type: "runtime_event";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: RuntimeEvent;
}

interface LockOwner {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

const metadataSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    name: z.string().min(1),
    projectPath: z.string().min(1),
    provider: z.enum(["openai", "deepseek"]),
    model: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    parentSessionId: z.string().min(1).optional(),
  })
  .strict();

// A deliberately supported chapter-era format demonstrates an explicit migration path.
const metadataSchemaV0 = z
  .object({
    schemaVersion: z.literal(0),
    id: z.string().min(1),
    title: z.string().min(1),
    cwd: z.string().min(1),
    provider: z.enum(["openai", "deepseek"]),
    model: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
  })
  .strict();

const transcriptRecordSchemaV1 = z.discriminatedUnion("type", [
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("message"),
    sequence: z.number().int().nonnegative(),
    recordedAt: z.string().min(1),
    message: transcriptMessageSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("reset"),
    sequence: z.number().int().nonnegative(),
    recordedAt: z.string().min(1),
  }).strict(),
]);

const transcriptRecordSchemaV0 = z
  .object({
    schemaVersion: z.literal(0),
    message: transcriptMessageSchema,
  })
  .strict();

const eventRecordSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("runtime_event"),
    sequence: z.number().int().nonnegative(),
    recordedAt: z.string().min(1),
    event: runtimeEventSchema,
  })
  .strict();

const eventRecordSchemaV0 = z
  .object({
    schemaVersion: z.literal(0),
    event: runtimeEventSchema,
  })
  .strict();

const lockOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  token: z.string().min(1),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  acquiredAt: z.string().min(1),
}).strict();

export class SessionCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionCorruptError";
  }
}

export class SessionLockedError extends Error {
  readonly owner: LockOwner | undefined;

  constructor(sessionId: string, owner?: LockOwner) {
    const details = owner === undefined
      ? "the lock owner could not be validated"
      : `process ${owner.pid} on ${owner.hostname} holds the lock`;
    super(`Session ${sessionId} is already open: ${details}.`);
    this.name = "SessionLockedError";
    this.owner = owner;
  }
}

export function defaultSessionRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.AGENT_CODE_SESSION_DIR?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".agent-code", "sessions")
    : resolve(configured);
}

export class SessionStore {
  readonly rootDirectory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #processId: number;
  readonly #hostName: string;

  constructor(options: SessionStoreOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#processId = options.processId ?? process.pid;
    this.#hostName = options.hostName ?? hostname();
  }

  async create(options: CreateSessionOptions): Promise<SessionHandle> {
    const sessionId = options.sessionId ?? this.#createId();
    validateSessionId(sessionId);
    if (options.parentSessionId !== undefined) validateSessionId(options.parentSessionId);
    const directory = this.#sessionDirectory(sessionId);
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new Error(`Session ${sessionId} already exists.`);
      }
      throw error;
    }

    const lock = await this.#acquireLock(sessionId);
    const timestamp = this.#now().toISOString();
    const metadata: SessionMetadata = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      name: options.name?.trim() || `session-${sessionId.slice(0, 8)}`,
      projectPath: resolve(options.projectPath),
      provider: options.provider,
      model: options.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.parentSessionId === undefined
        ? {}
        : { parentSessionId: options.parentSessionId }),
    };
    try {
      await writeMetadata(directory, metadata, this.#createId());
      const handle = new SessionHandle({
        directory,
        metadata,
        transcript: createTranscript(),
        transcriptRecordCount: 0,
        eventRecordCount: 0,
        lock,
        now: this.#now,
        createId: this.#createId,
      });
      if (options.transcript !== undefined) await handle.persistTranscript(options.transcript);
      return handle;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async open(sessionId: string): Promise<SessionHandle> {
    validateSessionId(sessionId);
    const directory = this.#sessionDirectory(sessionId);
    const lock = await this.#acquireLock(sessionId);
    try {
      const loaded = await loadSnapshot(directory, true);
      if (loaded.metadata.sessionId !== sessionId) {
        throw new SessionCorruptError(
          `Session directory ${sessionId} contains metadata for ${loaded.metadata.sessionId}.`,
        );
      }
      return new SessionHandle({
        directory,
        metadata: loaded.metadata,
        transcript: loaded.transcript,
        transcriptRecordCount: loaded.transcriptRecordCount,
        eventRecordCount: loaded.eventRecordCount,
        lock,
        now: this.#now,
        createId: this.#createId,
      });
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async read(sessionId: string): Promise<SessionSnapshot> {
    validateSessionId(sessionId);
    const loaded = await loadSnapshot(this.#sessionDirectory(sessionId));
    return {
      metadata: loaded.metadata,
      transcript: loaded.transcript,
      events: loaded.events,
    };
  }

  async fork(sourceSessionId: string, options: ForkSessionOptions = {}): Promise<SessionHandle> {
    const source = await this.read(sourceSessionId);
    return await this.create({
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      name: options.name ?? `${source.metadata.name} (fork)`,
      projectPath: options.projectPath ?? source.metadata.projectPath,
      provider: options.provider ?? source.metadata.provider,
      model: options.model ?? source.metadata.model,
      parentSessionId: source.metadata.sessionId,
      transcript: source.transcript,
    });
  }

  #sessionDirectory(sessionId: string): string {
    return join(this.rootDirectory, sessionId);
  }

  async #acquireLock(sessionId: string): Promise<SessionLock> {
    const directory = this.#sessionDirectory(sessionId);
    const path = join(directory, "writer.lock");
    const owner: LockOwner = {
      schemaVersion: 1,
      token: this.#createId(),
      pid: this.#processId,
      hostname: this.#hostName,
      acquiredAt: this.#now().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new SessionLock(path, owner);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = await readLockOwner(path);
        if (
          attempt === 0 &&
          existing !== undefined &&
          existing.hostname === this.#hostName &&
          !isProcessAlive(existing.pid)
        ) {
          try {
            await unlink(path);
          } catch (unlinkError) {
            if (!isNodeError(unlinkError, "ENOENT")) throw unlinkError;
          }
          continue;
        }
        throw new SessionLockedError(sessionId, existing);
      }
    }
    throw new SessionLockedError(sessionId);
  }
}

export class SessionHandle {
  metadata: SessionMetadata;
  transcript: Transcript;
  readonly directory: string;
  readonly #lock: SessionLock;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #transcriptRecordCount: number;
  #eventRecordCount: number;
  #closed = false;

  constructor(options: {
    readonly directory: string;
    readonly metadata: SessionMetadata;
    readonly transcript: Transcript;
    readonly transcriptRecordCount: number;
    readonly eventRecordCount: number;
    readonly lock: SessionLock;
    readonly now: () => Date;
    readonly createId: () => string;
  }) {
    this.directory = options.directory;
    this.metadata = options.metadata;
    this.transcript = options.transcript;
    this.#transcriptRecordCount = options.transcriptRecordCount;
    this.#eventRecordCount = options.eventRecordCount;
    this.#lock = options.lock;
    this.#now = options.now;
    this.#createId = options.createId;
  }

  async persistTranscript(transcript: Transcript): Promise<void> {
    this.#assertOpen();
    const validated = createTranscript(transcript.messages.map((message) =>
      transcriptMessageSchema.parse(message)));
    const previous = this.transcript.messages;
    const next = validated.messages;
    const prefixMatches = previous.length <= next.length && previous.every(
      (message, index) => JSON.stringify(message) === JSON.stringify(next[index]),
    );

    if (!prefixMatches) {
      await this.#appendTranscriptRecord({
        schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
        type: "reset",
        sequence: this.#transcriptRecordCount,
        recordedAt: this.#now().toISOString(),
      });
      for (const message of next) await this.#appendMessage(message);
    } else {
      for (const message of next.slice(previous.length)) await this.#appendMessage(message);
    }

    this.transcript = validated;
    await this.#touchMetadata();
  }

  async appendRuntimeEvent(event: RuntimeEvent): Promise<void> {
    this.#assertOpen();
    const validated = runtimeEventSchema.parse(event) as RuntimeEvent;
    const record: EventRecord = {
      schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
      type: "runtime_event",
      sequence: this.#eventRecordCount,
      recordedAt: this.#now().toISOString(),
      event: validated,
    };
    await appendJsonLine(join(this.directory, "events.jsonl"), record);
    this.#eventRecordCount += 1;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#lock.release();
  }

  async #appendMessage(message: TranscriptMessage): Promise<void> {
    await this.#appendTranscriptRecord({
      schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
      type: "message",
      sequence: this.#transcriptRecordCount,
      recordedAt: this.#now().toISOString(),
      message,
    });
  }

  async #appendTranscriptRecord(record: TranscriptRecord): Promise<void> {
    await appendJsonLine(join(this.directory, "transcript.jsonl"), record);
    this.#transcriptRecordCount += 1;
  }

  async #touchMetadata(): Promise<void> {
    this.metadata = {
      ...this.metadata,
      updatedAt: this.#now().toISOString(),
    };
    await writeMetadata(this.directory, this.metadata, this.#createId());
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Session ${this.metadata.sessionId} is closed.`);
  }
}

class SessionLock {
  readonly #path: string;
  readonly #owner: LockOwner;
  #released = false;

  constructor(path: string, owner: LockOwner) {
    this.#path = path;
    this.#owner = owner;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readLockOwner(this.#path);
    if (current?.token !== this.#owner.token) return;
    try {
      await unlink(this.#path);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

async function loadSnapshot(directory: string, repairLogs = false): Promise<SessionSnapshot & {
  readonly transcriptRecordCount: number;
  readonly eventRecordCount: number;
}> {
  const metadata = await readMetadata(join(directory, "metadata.json"));
  const transcriptRecords = await readJsonLines(
    join(directory, "transcript.jsonl"),
    decodeTranscriptRecord,
    repairLogs,
  );
  const eventRecords = await readJsonLines(
    join(directory, "events.jsonl"),
    decodeEventRecord,
    repairLogs,
  );
  const messages: TranscriptMessage[] = [];
  for (const [index, record] of transcriptRecords.entries()) {
    if (record.sequence !== index) {
      throw new SessionCorruptError(
        `Transcript record ${index} has sequence ${record.sequence}.`,
      );
    }
    if (record.type === "reset") messages.length = 0;
    else messages.push(record.message);
  }
  for (const [index, record] of eventRecords.entries()) {
    if (record.sequence !== index) {
      throw new SessionCorruptError(`Event record ${index} has sequence ${record.sequence}.`);
    }
  }
  return {
    metadata,
    transcript: createTranscript(messages),
    events: eventRecords.map((record) => record.event),
    transcriptRecordCount: transcriptRecords.length,
    eventRecordCount: eventRecords.length,
  };
}

async function readMetadata(path: string): Promise<SessionMetadata> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Session metadata not found at ${path}.`);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SessionCorruptError(`Session metadata at ${path} is not valid JSON.`, {
      cause: error,
    });
  }
  const version = readSchemaVersion(value);
  if (version === 1) return metadataSchemaV1.parse(value);
  if (version === 0) {
    const legacy = metadataSchemaV0.parse(value);
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: legacy.id,
      name: legacy.title,
      projectPath: resolve(legacy.cwd),
      provider: legacy.provider,
      model: legacy.model,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt ?? legacy.createdAt,
      ...(legacy.parentId === undefined ? {} : { parentSessionId: legacy.parentId }),
    };
  }
  throw new SessionCorruptError(`Unsupported session metadata schemaVersion: ${String(version)}.`);
}

function decodeTranscriptRecord(value: unknown, index: number): TranscriptRecord {
  const version = readSchemaVersion(value);
  if (version === 1) return transcriptRecordSchemaV1.parse(value) as TranscriptRecord;
  if (version === 0) {
    const legacy = transcriptRecordSchemaV0.parse(value);
    return {
      schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
      type: "message",
      sequence: index,
      recordedAt: legacy.message.createdAt,
      message: legacy.message,
    };
  }
  throw new SessionCorruptError(`Unsupported transcript record schemaVersion: ${String(version)}.`);
}

function decodeEventRecord(value: unknown, index: number): EventRecord {
  const version = readSchemaVersion(value);
  if (version === 1) return eventRecordSchemaV1.parse(value) as EventRecord;
  if (version === 0) {
    const legacy = eventRecordSchemaV0.parse(value);
    return {
      schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
      type: "runtime_event",
      sequence: index,
      recordedAt: legacy.event.timestamp,
      event: legacy.event as RuntimeEvent,
    };
  }
  throw new SessionCorruptError(`Unsupported event record schemaVersion: ${String(version)}.`);
}

async function readJsonLines<T>(
  path: string,
  decode: (value: unknown, index: number) => T,
  repairTruncatedTail = false,
): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  if (content.length === 0) return [];
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  if (terminated) lines.pop();
  const decoded: T[] = [];
  let ignoredFinalRecord = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      throw new SessionCorruptError(`Empty JSONL record at ${path}:${index + 1}.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      if (!terminated && index === lines.length - 1) {
        ignoredFinalRecord = true;
        break;
      }
      throw new SessionCorruptError(`Invalid JSONL record at ${path}:${index + 1}.`, {
        cause: error,
      });
    }
    try {
      decoded.push(decode(value, index));
    } catch (error) {
      throw new SessionCorruptError(`Invalid JSONL record at ${path}:${index + 1}.`, {
        cause: error,
      });
    }
  }
  if (repairTruncatedTail && !terminated) {
    if (ignoredFinalRecord) {
      const validPrefix = decoded.length === 0
        ? ""
        : `${lines.slice(0, decoded.length).join("\n")}\n`;
      await truncate(path, Buffer.byteLength(validPrefix, "utf8"));
    } else {
      const handle = await open(path, "a");
      try {
        await handle.writeFile("\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  return decoded;
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMetadata(
  directory: string,
  metadata: SessionMetadata,
  token: string,
): Promise<void> {
  const target = join(directory, "metadata.json");
  const temporary = join(directory, `.metadata-${token}.tmp`);
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return lockOwnerSchema.parse(value);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return undefined;
  }
}

function readSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) {
    throw new SessionCorruptError("Session record is missing schemaVersion.");
  }
  return (value as Record<string, unknown>).schemaVersion;
}

function validateSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
