import { z } from "zod";

const permissionRuleSchema = z.object({
  id: z.string().trim().min(1),
  action: z.enum(["allow", "ask", "deny"]),
  tools: z.array(z.string().trim().min(1)).min(1).optional(),
  sideEffects: z.array(z.enum([
    "read_workspace",
    "write_workspace",
    "execute_process",
    "network",
  ])).min(1).optional(),
  resources: z.array(z.string().trim().min(1).refine(
    (pattern) => !pattern.slice(0, -1).includes("*"),
    { message: "wildcard is only allowed as the final character" },
  )).min(1).optional(),
  reason: z.string().trim().min(1).optional(),
}).strict();

export const configurationSchema = z.object({
  version: z.literal(1).optional(),
  provider: z.enum(["openai", "deepseek"]).optional(),
  models: z.object({
    openai: z.string().trim().min(1).optional(),
    deepseek: z.string().trim().min(1).optional(),
  }).strict().optional(),
  sessionDirectory: z.string().trim().min(1).optional(),
  trustedWorkspaces: z.array(z.string().trim().min(1)).optional(),
  context: z.object({
    maxTokens: z.number().int().positive().optional(),
  }).strict().optional(),
  instructions: z.object({
    userPath: z.string().trim().min(1).optional(),
    maxFileBytes: z.number().int().positive().optional(),
    maxTotalBytes: z.number().int().positive().optional(),
  }).strict().optional(),
  turn: z.object({
    maxSteps: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxTestRuns: z.number().int().positive().optional(),
    maxRepairRounds: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  permissions: z.object({
    defaultDecision: z.enum(["allow", "ask", "deny"]).optional(),
    rules: z.array(permissionRuleSchema).optional(),
  }).strict().optional(),
}).strict();

export type Configuration = z.infer<typeof configurationSchema>;
