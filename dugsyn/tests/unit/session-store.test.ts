import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTranscript, type TranscriptMessage } from "../../src/messages/transcript.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { exportSessionMarkdown } from "../../src/sessions/export.js";
import {
  SessionLockedError,
  SessionStore,
} from "../../src/sessions/store.js";

const temporaryDirectories: string[] = [];
const now = () => new Date("2026-07-23T01:02:03.000Z");

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dugsyn-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

function userMessage(id = "message-1", text = "fix it"): TranscriptMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-07-23T01:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

const startedEvent: RuntimeEvent = {
  protocolVersion: 1,
  type: "turn_started",
  sequence: 0,
  timestamp: "2026-07-23T01:00:01.000Z",
  turnId: "turn-1",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("persists versioned metadata, transcript records, and runtime events", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({ rootDirectory, now });
    const handle = await store.create({
      sessionId: "session-1",
      name: "Repair parser",
      projectPath: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
    });
    await handle.persistTranscript(createTranscript([userMessage()]));
    await handle.appendRuntimeEvent(startedEvent);
    await handle.close();

    const snapshot = await store.read("session-1");
    expect(snapshot.metadata).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
      name: "Repair parser",
      projectPath: "/workspace/project",
    });
    expect(snapshot.transcript.messages).toEqual([userMessage()]);
    expect(snapshot.events).toEqual([startedEvent]);
    expect(await readFile(join(rootDirectory, "session-1", "transcript.jsonl"), "utf8"))
      .toContain('"schemaVersion":1');
  });

  it("recovers a dead writer lock and truncated final JSONL record", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({
      rootDirectory,
      now,
      hostName: "test-host",
      processId: process.pid,
    });
    const original = await store.create({
      sessionId: "crashed",
      projectPath: "/workspace/project",
      provider: "deepseek",
      model: "deepseek-test",
    });
    await original.persistTranscript(createTranscript([userMessage()]));
    await original.close();

    const directory = join(rootDirectory, "crashed");
    await appendFile(join(directory, "transcript.jsonl"), '{"schemaVersion":1,"type":"message"', "utf8");
    await writeFile(join(directory, "writer.lock"), JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2_147_483_647,
      hostname: "test-host",
      acquiredAt: "2026-07-23T00:00:00.000Z",
    }), "utf8");

    const recovered = await store.open("crashed");
    expect(recovered.transcript.messages).toEqual([userMessage()]);
    await recovered.persistTranscript(createTranscript([
      userMessage(),
      userMessage("message-2", "continue"),
    ]));
    await recovered.close();

    expect((await store.read("crashed")).transcript.messages).toHaveLength(2);
  });

  it("migrates supported schema-zero records while loading", async () => {
    const rootDirectory = await temporaryRoot();
    const directory = join(rootDirectory, "legacy");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "metadata.json"), JSON.stringify({
      schemaVersion: 0,
      id: "legacy",
      title: "Old session",
      cwd: "/workspace/old",
      provider: "openai",
      model: "gpt-old",
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "utf8");
    await writeFile(join(directory, "transcript.jsonl"), `${JSON.stringify({
      schemaVersion: 0,
      message: userMessage(),
    })}\n`, "utf8");
    await writeFile(join(directory, "events.jsonl"), `${JSON.stringify({
      schemaVersion: 0,
      event: startedEvent,
    })}\n`, "utf8");

    const snapshot = await new SessionStore({ rootDirectory }).read("legacy");
    expect(snapshot.metadata).toMatchObject({
      schemaVersion: 1,
      sessionId: "legacy",
      name: "Old session",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.transcript.messages).toEqual([userMessage()]);
    expect(snapshot.events).toEqual([startedEvent]);
  });

  it("rejects an unknown final schema even when the file lacks a newline", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({ rootDirectory });
    const handle = await store.create({
      sessionId: "future-schema",
      projectPath: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
    });
    await handle.close();
    await writeFile(
      join(rootDirectory, "future-schema", "transcript.jsonl"),
      JSON.stringify({ schemaVersion: 99, type: "message" }),
      "utf8",
    );

    await expect(store.read("future-schema")).rejects.toThrow(
      "Invalid JSONL record",
    );
  });

  it("rejects a second live writer for the same session", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({ rootDirectory });
    const first = await store.create({
      sessionId: "locked",
      projectPath: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
    });

    await expect(store.open("locked")).rejects.toBeInstanceOf(SessionLockedError);
    await first.close();
    const second = await store.open("locked");
    await second.close();
  });

  it("forks the conversation into an independent session without copying events", async () => {
    const rootDirectory = await temporaryRoot();
    let id = 0;
    const store = new SessionStore({
      rootDirectory,
      createId: () => `generated-${++id}`,
      now,
    });
    const source = await store.create({
      sessionId: "source",
      name: "Source",
      projectPath: "/workspace/source",
      provider: "openai",
      model: "gpt-test",
    });
    await source.persistTranscript(createTranscript([userMessage()]));
    await source.appendRuntimeEvent(startedEvent);
    await source.close();

    const fork = await store.fork("source", {
      sessionId: "branch",
      model: "gpt-new",
    });
    expect(fork.metadata).toMatchObject({
      sessionId: "branch",
      parentSessionId: "source",
      model: "gpt-new",
    });
    await fork.close();
    const branch = await store.read("branch");
    expect(branch.transcript.messages).toEqual([userMessage()]);
    expect(branch.events).toEqual([]);
  });

  it("represents conversation clearing as an append-only reset record", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({ rootDirectory, now });
    const handle = await store.create({
      sessionId: "cleared",
      projectPath: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
    });
    await handle.persistTranscript(createTranscript([userMessage()]));
    await handle.persistTranscript(createTranscript());
    await handle.close();

    expect((await store.read("cleared")).transcript.messages).toEqual([]);
    const records = await readFile(join(rootDirectory, "cleared", "transcript.jsonl"), "utf8");
    expect(records).toContain('"type":"message"');
    expect(records).toContain('"type":"reset"');
  });

  it("exports a readable Markdown view", async () => {
    const rootDirectory = await temporaryRoot();
    const store = new SessionStore({ rootDirectory, now });
    const handle = await store.create({
      sessionId: "export-me",
      name: "Readable session",
      projectPath: "/workspace/project",
      provider: "openai",
      model: "gpt-test",
    });
    await handle.persistTranscript(createTranscript([userMessage()]));
    await handle.appendRuntimeEvent(startedEvent);
    await handle.close();

    const markdown = exportSessionMarkdown(await store.read("export-me"));
    expect(markdown).toContain("# Readable session");
    expect(markdown).toContain("### User");
    expect(markdown).toContain("fix it");
    expect(markdown).toContain("turn_started");
  });
});
