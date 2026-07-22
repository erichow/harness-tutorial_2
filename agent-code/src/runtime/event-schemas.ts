import { z } from "zod";

import { toolResultBlockSchema } from "../messages/schemas.js";

const eventBase = {
  protocolVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  turnId: z.string().min(1),
};

const toolCallBlockSchema = z
  .object({
    type: z.literal("tool_call"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.json()),
  })
  .strict();

export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("turn_started") }).strict(),
  z.object({ ...eventBase, type: z.literal("text_delta"), delta: z.string() }).strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("reasoning_summary_delta"),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("tool_call_started"),
      call: toolCallBlockSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("tool_call_finished"),
      result: toolResultBlockSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("permission_requested"),
      requestId: z.string().min(1),
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("usage"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("provider_response"),
      provider: z.string().min(1),
      requestId: z.string().min(1),
      finishReason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("error"),
      category: z.enum(["user", "tool", "provider", "cancelled", "internal"]),
      message: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("turn_finished"),
      reason: z.enum(["completed", "max_steps", "cancelled", "error"]),
    })
    .strict(),
]);
