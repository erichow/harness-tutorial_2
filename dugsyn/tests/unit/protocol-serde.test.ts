import { describe, expect, it } from "vitest";

import { createTranscript, type TranscriptMessage } from "../../src/messages/transcript.js";
import {
  decodeRuntimeEvent,
  decodeTranscript,
  encodeRuntimeEvent,
  encodeTranscript,
  ProtocolDecodeError,
} from "../../src/protocol/serde.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";

const messages: TranscriptMessage[] = [
  {
    id: "message-1",
    role: "user",
    createdAt: "2026-07-22T12:00:00.000Z",
    content: [{ type: "text", text: "Fix the test" }],
  },
  {
    id: "message-2",
    role: "assistant",
    createdAt: "2026-07-22T12:00:01.000Z",
    content: [
      { type: "reasoning_summary", text: "I will inspect the failure." },
      {
        type: "tool_call",
        id: "call-1",
        name: "read_file",
        input: { path: "src/index.ts", lines: [1, 20] },
      },
    ],
  },
  {
    id: "message-3",
    role: "tool",
    createdAt: "2026-07-22T12:00:02.000Z",
    content: [
      {
        type: "tool_result",
        toolCallId: "call-1",
        status: "success",
        content: "1: export const answer = 42;",
        data: { path: "src/index.ts", truncated: false },
        output: {
          contentBytes: 28,
          totalContentBytes: 28,
          truncated: false,
          nextCursor: "line-2",
        },
      },
    ],
  },
];

const baseEvent = {
  protocolVersion: 1 as const,
  sequence: 0,
  timestamp: "2026-07-22T12:00:00.000Z",
  turnId: "turn-1",
};

const events: RuntimeEvent[] = [
  { ...baseEvent, type: "turn_started" },
  { ...baseEvent, sequence: 1, type: "text_delta", delta: "Hello" },
  {
    ...baseEvent,
    sequence: 2,
    type: "reasoning_summary_delta",
    delta: "Inspecting",
  },
  {
    ...baseEvent,
    sequence: 3,
    type: "tool_call_started",
    call: { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } },
  },
  {
    ...baseEvent,
    sequence: 4,
    type: "tool_call_finished",
    result: {
      type: "tool_result",
      toolCallId: "call-1",
      status: "success",
      content: "ok",
      data: { bytes: 2 },
      output: {
        contentBytes: 2,
        totalContentBytes: 2,
        truncated: false,
      },
    },
  },
  {
    ...baseEvent,
    sequence: 5,
    type: "permission_requested",
    requestId: "permission-1",
    toolCallId: "call-2",
    toolName: "shell",
    reason: "Command writes files",
  },
  {
    ...baseEvent,
    sequence: 6,
    type: "permission_decided",
    requestId: "permission-1",
    toolCallId: "call-2",
    toolName: "shell",
    decision: "allow",
    scope: "once",
    reason: "User approved",
  },
  {
    ...baseEvent,
    sequence: 7,
    type: "usage",
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: 2,
  },
  {
    ...baseEvent,
    sequence: 8,
    type: "provider_response",
    provider: "openai",
    requestId: "resp_123",
    finishReason: "completed",
  },
  {
    ...baseEvent,
    sequence: 9,
    type: "error",
    category: "provider",
    message: "rate limited",
    retryable: true,
  },
  { ...baseEvent, sequence: 10, type: "turn_finished", reason: "completed" },
];

describe("transcript serialization", () => {
  it("round-trips every content block", () => {
    const transcript = createTranscript(messages);

    expect(decodeTranscript(encodeTranscript(transcript))).toEqual(transcript);
  });

  it("rejects unsupported schema versions explicitly", () => {
    expect(() =>
      decodeTranscript(JSON.stringify({ schemaVersion: 2, messages: [] })),
    ).toThrow("Unsupported transcript schemaVersion: 2");
  });

  it("rejects malformed and unknown content blocks", () => {
    const invalid = {
      schemaVersion: 1,
      messages: [
        {
          id: "message-1",
          role: "user",
          createdAt: "now",
          content: [{ type: "vendor_secret_block", value: "no" }],
        },
      ],
    };

    expect(() => decodeTranscript(JSON.stringify(invalid))).toThrow(ProtocolDecodeError);
  });
});

describe("runtime event serialization", () => {
  it.each(events.map((event) => [event.type, event] as const))(
    "round-trips %s",
    (_type, event) => {
      expect(decodeRuntimeEvent(encodeRuntimeEvent(event))).toEqual(event);
    },
  );

  it("rejects unknown protocol versions before event validation", () => {
    expect(() =>
      decodeRuntimeEvent(
        JSON.stringify({
          ...baseEvent,
          protocolVersion: 99,
          type: "turn_started",
        }),
      ),
    ).toThrow("Unsupported runtime protocolVersion: 99");
  });

  it("rejects invalid JSON with a stable error type", () => {
    expect(() => decodeRuntimeEvent("{"))
      .toThrow(ProtocolDecodeError);
  });
});
