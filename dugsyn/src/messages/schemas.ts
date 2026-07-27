import { z } from "zod";

const textBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const toolCallBlockSchema = z
  .object({
    type: z.literal("tool_call"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.json()),
  })
  .strict();

export const toolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1),
    status: z.enum(["success", "error"]),
    content: z.string(),
    data: z.json().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
    output: z
      .object({
        contentBytes: z.number().int().nonnegative(),
        totalContentBytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        nextCursor: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const reasoningSummaryBlockSchema = z
  .object({
    type: z.literal("reasoning_summary"),
    text: z.string(),
  })
  .strict();

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolCallBlockSchema,
  toolResultBlockSchema,
  reasoningSummaryBlockSchema,
]);

export const transcriptMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.array(contentBlockSchema),
    createdAt: z.string().min(1),
  })
  .strict();

export const transcriptSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    messages: z.array(transcriptMessageSchema),
  })
  .strict();
