import { z } from "zod";

import type { RuntimeEvent, TurnFinishReason } from "../runtime/events.js";
import type { TestRunSummary } from "../runtime/test-loop.js";

export const HEADLESS_PROTOCOL_VERSION = 1 as const;

export const headlessRequestSchema = z
  .object({
    protocolVersion: z.literal(HEADLESS_PROTOCOL_VERSION),
    type: z.literal("request"),
    requestId: z.string().trim().min(1).optional(),
    prompt: z.string().refine((value) => value.trim().length > 0, {
      message: "prompt must not be empty",
    }),
  })
  .strict();

export type HeadlessInputRequest = z.infer<typeof headlessRequestSchema>;
export type HeadlessExitCode = 0 | 1 | 2 | 3 | 4 | 130;

export interface HeadlessPermissionDenial {
  readonly toolName: string;
  readonly reason: string;
}

export interface HeadlessError {
  readonly category: "user" | "tool" | "provider" | "cancelled" | "internal";
  readonly message: string;
  readonly retryable: boolean;
}

export interface HeadlessResultRecord {
  readonly protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
  readonly type: "result";
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason: TurnFinishReason;
  readonly exitCode: HeadlessExitCode;
  readonly text: string;
  readonly steps: number;
  readonly tests: TestRunSummary;
  readonly permissionDenials: readonly HeadlessPermissionDenial[];
  readonly error?: HeadlessError | undefined;
}

export interface HeadlessEventRecord {
  readonly protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
  readonly type: "event";
  readonly requestId: string;
  readonly event: RuntimeEvent;
}

export interface HeadlessBatchResult {
  readonly protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
  readonly type: "batch_result";
  readonly sessionId: string;
  readonly results: readonly HeadlessResultRecord[];
  readonly exitCode: HeadlessExitCode;
}
