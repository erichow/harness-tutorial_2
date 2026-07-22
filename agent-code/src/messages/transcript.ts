import type { ContentBlock } from "./blocks.js";

export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TranscriptMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
  readonly createdAt: string;
}

export interface Transcript {
  readonly schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly messages: readonly TranscriptMessage[];
}

export function createTranscript(
  messages: readonly TranscriptMessage[] = [],
): Transcript {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    messages: [...messages],
  };
}
