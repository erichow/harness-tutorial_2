import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ConfigurationError, loadConfiguration } from "../config/loader.js";
import type { Transcript } from "../messages/transcript.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses.js";
import { DeepSeekChatProvider } from "../providers/deepseek-chat.js";
import type { Provider } from "../providers/provider.js";
import { CodingAgentRuntime } from "../runtime/coding-agent.js";
import type { RunTurnResult } from "../runtime/agent.js";
import type { RuntimeEvent } from "../runtime/events.js";
import { resolveTurnLimits } from "../runtime/limits.js";
import { PermissionEngine } from "../security/permissions.js";
import {
  assertHostAllowed,
  createManagedAuditExporter,
} from "../security/team-policy.js";
import { SessionStore } from "../sessions/store.js";
import { createPlatformSandboxRunner } from "../tools/shell/sandbox-runner.js";
import {
  chatDefaults,
  explicitWorkspace,
  parseChatArgs,
  requireApiKey,
  resolveSessionContext,
  runtimeContext,
  runtimeExtensions,
  type ChatCliOptions,
  type ChatConfigurationDefaults,
} from "./chat.js";
import {
  HEADLESS_PROTOCOL_VERSION,
  headlessRequestSchema,
  type HeadlessBatchResult,
  type HeadlessError,
  type HeadlessEventRecord,
  type HeadlessExitCode,
  type HeadlessInputRequest,
  type HeadlessPermissionDenial,
  type HeadlessResultRecord,
} from "./headless-protocol.js";

export type HeadlessInputFormat = "text" | "jsonl";
export type HeadlessOutputFormat = "text" | "json" | "jsonl";

export interface HeadlessCliOptions extends ChatCliOptions {
  readonly prompt?: string | undefined;
  readonly inputFormat: HeadlessInputFormat;
  readonly outputFormat: HeadlessOutputFormat;
}

export interface HeadlessIO {
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: {
    write(chunk: string): unknown;
    once?(event: "drain", listener: () => void): unknown;
  };
  readonly stderr: { write(chunk: string): unknown };
}

export interface HeadlessSession {
  readonly sessionId: string;
  readonly initialTranscript: Transcript;
  persistTranscript(transcript: Transcript): Promise<void>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
  runTurn(options: {
    readonly transcript: Transcript;
    readonly signal: AbortSignal;
    readonly emit: (event: RuntimeEvent) => void | Promise<void>;
  }): Promise<RunTurnResult>;
}

export interface RunHeadlessOptions {
  readonly prompt?: string | undefined;
  readonly inputFormat: HeadlessInputFormat;
  readonly outputFormat: HeadlessOutputFormat;
  readonly io: HeadlessIO;
  readonly session: HeadlessSession;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
}

export interface HeadlessProviderContext {
  readonly provider: "openai" | "deepseek";
  readonly model: string;
  readonly apiKey: string;
}

export interface HeadlessCliDependencies {
  readonly cwd?: string | undefined;
  readonly io?: HeadlessIO | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
  readonly createProvider?: ((context: HeadlessProviderContext) => Provider) | undefined;
}

interface ParsedHeadlessSyntax {
  readonly prompt?: string | undefined;
  readonly inputFormat: HeadlessInputFormat;
  readonly outputFormat: HeadlessOutputFormat;
  readonly chatArgs: readonly string[];
}

export class HeadlessUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeadlessUsageError";
  }
}

const CHAT_VALUE_OPTIONS = new Set([
  "--provider",
  "--model",
  "--workspace",
  "--session-dir",
  "--session-name",
  "--resume",
  "--fork-session",
]);

export function parseHeadlessArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  defaults: ChatConfigurationDefaults = {},
): HeadlessCliOptions {
  const syntax = parseHeadlessSyntax(args);
  let chat: ChatCliOptions;
  try {
    chat = parseChatArgs(syntax.chatArgs, environment, cwd, defaults);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HeadlessUsageError(message, { cause: error });
  }
  return {
    ...chat,
    ...(syntax.prompt === undefined ? {} : { prompt: syntax.prompt }),
    inputFormat: syntax.inputFormat,
    outputFormat: syntax.outputFormat,
  };
}

export async function runHeadlessCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HeadlessCliDependencies = {},
): Promise<HeadlessExitCode> {
  const io = dependencies.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const ownedController = dependencies.signal === undefined
    ? new AbortController()
    : undefined;
  const signal = dependencies.signal ?? ownedController?.signal ??
    new AbortController().signal;
  const handleInterrupt = (): void => {
    if (!signal.aborted) ownedController?.abort(new Error("Cancelled by SIGINT"));
  };
  if (ownedController !== undefined) process.once("SIGINT", handleInterrupt);
  let runtime: CodingAgentRuntime | undefined;
  let handle: Awaited<ReturnType<typeof resolveSessionContext>>["handle"] | undefined;

  try {
    const syntax = parseHeadlessSyntax(args);
    const initialWorkspace = explicitWorkspace(syntax.chatArgs, cwd) ?? cwd;
    const initialConfiguration = await loadConfiguration({
      workspaceRoot: initialWorkspace,
      environment,
      cwd,
    });
    const options = parseHeadlessArgs(
      args,
      environment,
      cwd,
      chatDefaults(initialConfiguration),
    );
    if (
      options.resumeSessionId === undefined &&
      options.forkSessionId === undefined &&
      options.provider !== undefined
    ) {
      requireHeadlessApiKey(options.provider, environment);
    }

    const store = new SessionStore({ rootDirectory: options.sessionDirectory });
    let context: Awaited<ReturnType<typeof resolveSessionContext>>;
    try {
      context = await resolveSessionContext(store, options, environment, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HeadlessUsageError(message, { cause: error });
    }
    handle = context.handle;
    const activeHandle = handle;
    const apiKey = requireHeadlessApiKey(context.provider, environment);
    const configuration = resolve(context.workspace) === initialConfiguration.trust.workspaceRoot
      ? initialConfiguration
      : await loadConfiguration({ workspaceRoot: context.workspace, environment, cwd });
    assertHostAllowed(configuration, "cli");
    const provider = dependencies.createProvider?.({
      provider: context.provider,
      model: context.model,
      apiKey,
    }) ?? createProvider({
      provider: context.provider,
      model: context.model,
      apiKey,
    });
    const permissions = new PermissionEngine({
      trust: configuration.trust,
      managedRules: configuration.permissions.managedRules,
      userRules: configuration.permissions.userRules,
      projectRules: configuration.permissions.projectRules,
      ...(configuration.permissions.defaultDecision === undefined
        ? {}
        : { defaultDecision: configuration.permissions.defaultDecision }),
      // Deliberately no interactive `decide` callback. An `ask` decision is
      // denied safely in a pipe or CI job instead of blocking forever.
    });
    runtime = await CodingAgentRuntime.create({
      provider,
      workspaceRoot: configuration.trust.workspaceRoot,
      permissions,
      shell: {
        runner: createPlatformSandboxRunner({
          workspaceRoot: configuration.trust.workspaceRoot,
          allowNetwork: false,
          fallback: "closed",
        }),
      },
      context: runtimeContext(configuration, context.provider, context.model),
      observability: {
        sessionId: activeHandle.metadata.sessionId,
        auditExporter: createManagedAuditExporter({
          configuration,
          environment,
          sessionId: activeHandle.metadata.sessionId,
          diagnostic: (message) => io.stderr.write(`${message}\n`),
        }),
      },
      extensions: runtimeExtensions(
        configuration,
        environment,
        (message) => io.stderr.write(`${message}\n`),
      ),
    });
    const activeRuntime = runtime;
    return await runHeadless({
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      inputFormat: options.inputFormat,
      outputFormat: options.outputFormat,
      io,
      session: {
        sessionId: activeHandle.metadata.sessionId,
        initialTranscript: activeHandle.transcript,
        persistTranscript: async (transcript) => await activeHandle.persistTranscript(transcript),
        appendRuntimeEvent: async (event) => await activeHandle.appendRuntimeEvent(event),
        runTurn: async (turn) => await activeRuntime.runTurn({
          ...turn,
          limits: resolveTurnLimits(configuration.turn),
        }),
      },
      signal,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createId === undefined ? {} : { createId: dependencies.createId }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted) {
      io.stderr.write(`Headless execution cancelled: ${message}\n`);
      return 130;
    }
    if (error instanceof HeadlessUsageError || error instanceof ConfigurationError) {
      io.stderr.write(`Input error: ${message}\n`);
      return 2;
    }
    io.stderr.write(`Internal error: ${message}\n`);
    return 1;
  } finally {
    if (ownedController !== undefined) process.removeListener("SIGINT", handleInterrupt);
    await runtime?.dispose();
    await handle?.close();
  }
}

export async function runHeadless(options: RunHeadlessOptions): Promise<HeadlessExitCode> {
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  let transcript = options.session.initialTranscript;
  const results: HeadlessResultRecord[] = [];
  let aggregateExitCode: HeadlessExitCode = 0;
  let requestCount = 0;
  const requestIds = new Set<string>();

  for await (const request of readRequests(options, createId)) {
    signal.throwIfAborted();
    requestCount += 1;
    const requestId = request.requestId ?? createId();
    if (requestIds.has(requestId)) {
      throw new HeadlessUsageError(`Duplicate requestId: ${requestId}`);
    }
    requestIds.add(requestId);
    const messageBoundary = transcript.messages.length;
    transcript = {
      ...transcript,
      messages: [
        ...transcript.messages,
        {
          id: createId(),
          role: "user",
          content: [{ type: "text", text: request.prompt }],
          createdAt: now().toISOString(),
        },
      ],
    };
    await options.session.persistTranscript(transcript);

    const permissionDenials: HeadlessPermissionDenial[] = [];
    let runtimeError: HeadlessError | undefined;
    const result = await options.session.runTurn({
      transcript,
      signal,
      emit: async (event) => {
        await options.session.appendRuntimeEvent(event);
        if (event.type === "permission_decided" && event.decision === "deny") {
          permissionDenials.push({
            toolName: event.toolName,
            reason: event.reason,
          });
        } else if (event.type === "error") {
          runtimeError = {
            category: event.category,
            message: event.message,
            retryable: event.retryable,
          };
        }
        if (options.outputFormat === "jsonl") {
          await writeJsonLine(options.io.stdout, {
            protocolVersion: HEADLESS_PROTOCOL_VERSION,
            type: "event",
            requestId,
            event,
          } satisfies HeadlessEventRecord);
        }
      },
    });
    transcript = result.transcript;
    await options.session.persistTranscript(transcript);
    const exitCode = exitCodeFor(result.reason, permissionDenials.length > 0);
    const record: HeadlessResultRecord = {
      protocolVersion: HEADLESS_PROTOCOL_VERSION,
      type: "result",
      requestId,
      sessionId: options.session.sessionId,
      turnId: result.turnId,
      reason: result.reason,
      exitCode,
      text: finalAssistantText(transcript, messageBoundary),
      steps: result.steps,
      tests: result.tests,
      permissionDenials,
      ...(runtimeError === undefined ? {} : { error: runtimeError }),
    };
    results.push(record);
    aggregateExitCode = combineExitCodes(aggregateExitCode, exitCode);
    await renderResult(record, options.outputFormat, options.io);
  }

  if (requestCount === 0) {
    throw new HeadlessUsageError("No input requests were provided.");
  }
  if (options.outputFormat === "json") {
    await writeJsonLine(options.io.stdout, {
      protocolVersion: HEADLESS_PROTOCOL_VERSION,
      type: "batch_result",
      sessionId: options.session.sessionId,
      results,
      exitCode: aggregateExitCode,
    } satisfies HeadlessBatchResult);
  }
  return aggregateExitCode;
}

function parseHeadlessSyntax(args: readonly string[]): ParsedHeadlessSyntax {
  let sawPrint = false;
  let prompt: string | undefined;
  let inputFormat: HeadlessInputFormat = "text";
  let outputFormat: HeadlessOutputFormat = "text";
  const chatArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--print") {
      if (sawPrint) throw new HeadlessUsageError("--print may only be specified once.");
      sawPrint = true;
      const candidate = args[index + 1];
      if (candidate !== undefined && !candidate.startsWith("-")) {
        prompt = candidate;
        index += 1;
      }
      continue;
    }
    if (argument?.startsWith("--print=")) {
      if (sawPrint) throw new HeadlessUsageError("--print may only be specified once.");
      sawPrint = true;
      prompt = argument.slice("--print=".length);
      continue;
    }
    if (argument === "--input-format" || argument === "--output-format") {
      const value = args[index + 1];
      if (value === undefined) throw new HeadlessUsageError(`${argument} requires a value.`);
      if (argument === "--input-format") {
        if (value !== "text" && value !== "jsonl") {
          throw new HeadlessUsageError("--input-format must be text or jsonl.");
        }
        inputFormat = value;
      } else {
        if (value !== "text" && value !== "json" && value !== "jsonl") {
          throw new HeadlessUsageError("--output-format must be text, json, or jsonl.");
        }
        outputFormat = value;
      }
      index += 1;
      continue;
    }
    if (argument !== undefined && CHAT_VALUE_OPTIONS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new HeadlessUsageError(`${argument} requires a value.`);
      chatArgs.push(argument, value);
      index += 1;
      continue;
    }
    throw new HeadlessUsageError(`Unknown headless argument: ${argument ?? ""}`);
  }

  if (!sawPrint) throw new HeadlessUsageError("Headless mode requires --print.");
  if (prompt !== undefined && prompt.trim().length === 0) {
    throw new HeadlessUsageError("--print prompt must not be empty.");
  }
  if (inputFormat === "jsonl" && prompt !== undefined) {
    throw new HeadlessUsageError("--print prompt cannot be combined with --input-format jsonl.");
  }
  return {
    ...(prompt === undefined ? {} : { prompt }),
    inputFormat,
    outputFormat,
    chatArgs,
  };
}

async function* readRequests(
  options: Pick<RunHeadlessOptions, "prompt" | "inputFormat" | "io">,
  createId: () => string,
): AsyncIterable<HeadlessInputRequest> {
  if (options.prompt !== undefined) {
    yield {
      protocolVersion: HEADLESS_PROTOCOL_VERSION,
      type: "request",
      requestId: createId(),
      prompt: options.prompt,
    };
    return;
  }
  if (options.inputFormat === "text") {
    const prompt = stripOneTrailingNewline(await readAll(options.io.stdin));
    if (prompt.trim().length === 0) {
      throw new HeadlessUsageError("Text input from stdin must not be empty.");
    }
    yield {
      protocolVersion: HEADLESS_PROTOCOL_VERSION,
      type: "request",
      requestId: createId(),
      prompt,
    };
    return;
  }

  let lineNumber = 0;
  for await (const line of readLines(options.io.stdin)) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HeadlessUsageError(`JSONL line ${lineNumber} is not valid JSON: ${message}`, {
        cause: error,
      });
    }
    const parsed = headlessRequestSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length === 0 ? "$" : issue?.path.join(".");
      throw new HeadlessUsageError(
        `JSONL line ${lineNumber} is invalid at ${path ?? "$"}: ${issue?.message ?? "schema validation failed"}`,
        { cause: parsed.error },
      );
    }
    yield parsed.data;
  }
}

async function readAll(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of input) {
    output += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return output + decoder.decode();
}

async function* readLines(
  input: AsyncIterable<string | Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      yield line;
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending.replace(/\r$/u, "");
}

function stripOneTrailingNewline(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function finalAssistantText(transcript: Transcript, boundary: number): string {
  const message = transcript.messages
    .slice(boundary)
    .findLast((candidate) => candidate.role === "assistant");
  if (message === undefined) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function exitCodeFor(
  reason: RunTurnResult["reason"],
  permissionDenied: boolean,
): HeadlessExitCode {
  if (reason === "cancelled") return 130;
  if (reason === "error") return 1;
  if (reason === "max_steps" || reason === "max_duration" || reason === "max_tokens") return 3;
  if (permissionDenied) return 4;
  return 0;
}

function combineExitCodes(
  current: HeadlessExitCode,
  next: HeadlessExitCode,
): HeadlessExitCode {
  if (current === 130 || next === 130) return 130;
  if (current === 1 || next === 1) return 1;
  if (current === 3 || next === 3) return 3;
  if (current === 4 || next === 4) return 4;
  if (current === 2 || next === 2) return 2;
  return 0;
}

async function renderResult(
  result: HeadlessResultRecord,
  outputFormat: HeadlessOutputFormat,
  io: HeadlessIO,
): Promise<void> {
  if (outputFormat === "text") {
    if (result.text.length > 0) await writeOutput(io.stdout, `${result.text}\n`);
  } else if (outputFormat === "jsonl") {
    await writeJsonLine(io.stdout, result);
  }

  if (result.exitCode === 0) return;
  if (result.exitCode === 130) {
    io.stderr.write(`Request ${result.requestId} cancelled.\n`);
  } else if (result.exitCode === 4) {
    io.stderr.write(`Request ${result.requestId} denied by permission policy.\n`);
  } else if (result.exitCode === 3) {
    io.stderr.write(`Request ${result.requestId} stopped after reaching ${result.reason}.\n`);
  } else {
    io.stderr.write(
      `Request ${result.requestId} failed: ${result.error?.message ?? result.reason}.\n`,
    );
  }
}

async function writeJsonLine(
  output: HeadlessIO["stdout"],
  value: HeadlessEventRecord | HeadlessResultRecord | HeadlessBatchResult,
): Promise<void> {
  await writeOutput(output, `${JSON.stringify(value)}\n`);
}

async function writeOutput(
  output: HeadlessIO["stdout"],
  chunk: string,
): Promise<void> {
  const accepted = output.write(chunk);
  if (accepted !== false || output.once === undefined) return;
  await new Promise<void>((resolveDrain) => {
    output.once?.("drain", resolveDrain);
  });
}

function createProvider(context: HeadlessProviderContext): Provider {
  return context.provider === "openai"
    ? new OpenAIResponsesProvider({ apiKey: context.apiKey, model: context.model })
    : new DeepSeekChatProvider({ apiKey: context.apiKey, model: context.model });
}

function requireHeadlessApiKey(
  provider: "openai" | "deepseek",
  environment: NodeJS.ProcessEnv,
): string {
  try {
    return requireApiKey(provider, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HeadlessUsageError(message, { cause: error });
  }
}
