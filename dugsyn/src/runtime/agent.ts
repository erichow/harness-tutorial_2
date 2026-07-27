import { randomUUID } from "node:crypto";

import type { ContentBlock, ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { Transcript, TranscriptMessage } from "../messages/transcript.js";
import type { ContextPreparer, ContextReport } from "../context/manager.js";
import {
  ProviderError,
  type Provider,
  type ProviderStreamEvent,
} from "../providers/provider.js";
import type { ToolExecutor, ToolPermissionEvent } from "../tools/executor.js";
import { createToolErrorResult } from "../tools/result.js";
import { isCancellation, throwIfCancelled } from "./cancellation.js";
import {
  resolveTurnLimits,
  type TurnLimits,
  validateTurnLimits,
} from "./limits.js";
import { createTestLoopExecutor, type TestRunSummary } from "./test-loop.js";
import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  type ErrorCategory,
  type RuntimeEvent,
  type TurnFinishReason,
} from "./events.js";

export interface RunTurnOptions {
  readonly provider: Provider;
  readonly transcript: Transcript;
  readonly tools: ToolExecutor;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: TurnLimits | undefined;
  readonly context?: ContextPreparer | undefined;
  readonly emit?: ((event: RuntimeEvent) => void | Promise<void>) | undefined;
  /** Test seams; normal callers should leave these unset. */
  readonly now?: (() => Date) | undefined;
  readonly createId?: (() => string) | undefined;
}

export interface RunTurnResult {
  readonly transcript: Transcript;
  readonly reason: TurnFinishReason;
  readonly steps: number;
  readonly turnId: string;
  readonly tests: TestRunSummary;
  readonly context?: ContextReport | undefined;
}

type RuntimeEventPayload = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent
    ? Omit<Event, "protocolVersion" | "sequence" | "timestamp" | "turnId">
    : never
  : never;

class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

class ProviderStepError extends Error {
  readonly partialContent: readonly ContentBlock[];
  readonly retryable: boolean;

  constructor(
    message: string,
    partialContent: readonly ContentBlock[],
    options: { readonly cause: unknown; readonly retryable: boolean },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderStepError";
    this.partialContent = partialContent;
    this.retryable = options.retryable;
  }
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const limits = resolveTurnLimits(options.limits);
  validateTurnLimits(limits);

  const callerSignal = options.signal ?? new AbortController().signal;
  const durationController = new AbortController();
  const durationTimer = setTimeout(() => {
    durationController.abort(new Error(`Turn duration limit reached (${limits.maxDurationMs} ms)`));
  }, limits.maxDurationMs);
  durationTimer.unref();
  const signal = AbortSignal.any([callerSignal, durationController.signal]);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const turnId = createId();
  let sequence = 0;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let transcript = options.transcript;
  let contextReport: ContextReport | undefined;
  const testLoop = createTestLoopExecutor(options.tools, limits);

  const emit = async (
    event: RuntimeEventPayload,
  ): Promise<void> => {
    if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    }
    await options.emit?.({
      ...event,
      protocolVersion: RUNTIME_EVENT_PROTOCOL_VERSION,
      sequence,
      timestamp: now().toISOString(),
      turnId,
    } as RuntimeEvent);
    sequence += 1;
  };

  const finish = async (reason: TurnFinishReason): Promise<RunTurnResult> => {
    const tests = testLoop.summary();
    await emit({ type: "turn_finished", reason, tests });
    return {
      transcript,
      reason,
      steps,
      turnId,
      tests,
      ...(contextReport === undefined ? {} : { context: contextReport }),
    };
  };

  await emit({ type: "turn_started" });

  try {
    while (steps < limits.maxSteps) {
      throwIfCancelled(signal);
      steps += 1;

      const prepared = options.context === undefined
        ? { transcript, report: undefined }
        : await options.context.prepare(transcript, testLoop.executor.definitions);
      contextReport = prepared.report;
      await emit({
        type: "provider_request_started",
        provider: options.provider.name,
        step: steps,
      });
      const streamed = await consumeProviderResponse({
        provider: options.provider,
        transcript: prepared.transcript,
        tools: testLoop.executor,
        signal,
        emit,
      });

      await emit({
        type: "provider_response",
        provider: options.provider.name,
        requestId: streamed.requestId,
        finishReason: streamed.providerFinishReason,
      });

      transcript = appendMessage(transcript, {
        id: createId(),
        role: "assistant",
        content: streamed.content,
        createdAt: now().toISOString(),
      });

      if (inputTokens > limits.maxInputTokens || outputTokens > limits.maxOutputTokens) {
        return await finish("max_tokens");
      }

      if (streamed.toolCalls.length === 0) {
        if (streamed.finishReason !== "stop") {
          throw new ProviderProtocolError(
            "Provider finished with tool_calls but emitted no tool calls",
          );
        }
        return await finish("completed");
      }

      if (streamed.finishReason !== "tool_calls") {
        throw new ProviderProtocolError(
          "Provider emitted tool calls but did not finish with tool_calls",
        );
      }

      const results: ToolResultBlock[] = [];
      for (const call of streamed.toolCalls) {
        throwIfCancelled(signal);
        await emit({ type: "tool_call_started", call });
        let result: ToolResultBlock;
        try {
          result = await testLoop.executor.execute(call, {
            signal,
            emitPermission: async (event) => await emitPermissionEvent(emit, event),
          });
        } catch (error) {
          if (isCancellation(error, signal)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          result = createToolErrorResult(
            call.id,
            "execution_failed",
            `Tool ${call.name} failed: ${message}`,
          );
        }
        results.push(result);
        await emit({ type: "tool_call_finished", result });
      }

      transcript = appendMessage(transcript, {
        id: createId(),
        role: "tool",
        content: results,
        createdAt: now().toISOString(),
      });
    }

    return await finish("max_steps");
  } catch (error) {
    if (durationController.signal.aborted) {
      await emitError(emit, "internal", durationController.signal.reason instanceof Error
        ? durationController.signal.reason.message
        : "Turn duration limit reached", false);
      return await finish("max_duration");
    }
    if (isCancellation(error, callerSignal)) {
      await emitError(emit, "cancelled", "Turn cancelled", false);
      return await finish("cancelled");
    }

    if (error instanceof ProviderStepError && error.partialContent.length > 0) {
      transcript = appendMessage(transcript, {
        id: createId(),
        role: "assistant",
        content: error.partialContent,
        createdAt: now().toISOString(),
      });
    }

    const category: ErrorCategory = "provider";
    const message = error instanceof Error ? error.message : String(error);
    const retryable =
      error instanceof ProviderStepError
        ? error.retryable
        : error instanceof ProviderError
          ? error.retryable
          : false;
    await emitError(emit, category, message, retryable);
    return await finish("error");
  } finally {
    clearTimeout(durationTimer);
  }
}

async function emitPermissionEvent(
  emit: (event: RuntimeEventPayload) => Promise<void>,
  event: ToolPermissionEvent,
): Promise<void> {
  if (event.type === "permission_requested") {
    await emit(event);
    return;
  }
  await emit(event);
}

interface ConsumedProviderResponse {
  readonly content: readonly ContentBlock[];
  readonly toolCalls: readonly ToolCallBlock[];
  readonly finishReason: "stop" | "tool_calls";
  readonly requestId: string;
  readonly providerFinishReason: string;
}

async function consumeProviderResponse(options: {
  readonly provider: Provider;
  readonly transcript: Transcript;
  readonly tools: ToolExecutor;
  readonly signal: AbortSignal;
  readonly emit: (
    event: RuntimeEventPayload,
  ) => Promise<void>;
}): Promise<ConsumedProviderResponse> {
  const content: ContentBlock[] = [];
  const toolCalls: ToolCallBlock[] = [];
  let finishReason: "stop" | "tool_calls" | undefined;
  let requestId: string | undefined;
  let providerFinishReason: string | undefined;

  try {
    for await (const event of options.provider.stream({
      transcript: options.transcript,
      tools: options.tools.definitions,
      signal: options.signal,
    })) {
      throwIfCancelled(options.signal);
      if (finishReason !== undefined) {
        throw new ProviderProtocolError("Provider emitted an event after response_completed");
      }
      await consumeEvent(event, content, toolCalls, options.emit);
      if (event.type === "response_completed") {
        finishReason = event.finishReason;
        requestId = event.requestId;
        providerFinishReason = event.providerFinishReason;
      }
    }
  } catch (error) {
    if (isCancellation(error, options.signal)) throw error;
    if (error instanceof ProviderProtocolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderStepError(
      message,
      content.filter((block) => block.type !== "tool_call"),
      {
        cause: error,
        retryable: error instanceof ProviderError ? error.retryable : false,
      },
    );
  }

  if (
    finishReason === undefined ||
    requestId === undefined ||
    providerFinishReason === undefined
  ) {
    throw new ProviderProtocolError("Provider stream ended without response_completed");
  }

  return {
    content,
    toolCalls,
    finishReason,
    requestId,
    providerFinishReason,
  };
}

async function consumeEvent(
  event: ProviderStreamEvent,
  content: ContentBlock[],
  toolCalls: ToolCallBlock[],
  emit: (
    event: RuntimeEventPayload,
  ) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case "text_delta":
      appendText(content, "text", event.delta);
      await emit({ type: "text_delta", delta: event.delta });
      return;
    case "reasoning_summary_delta":
      appendText(content, "reasoning_summary", event.delta);
      await emit({ type: "reasoning_summary_delta", delta: event.delta });
      return;
    case "tool_call":
      content.push(event.call);
      toolCalls.push(event.call);
      return;
    case "usage":
      await emit({
        type: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: event.cachedInputTokens }),
      });
      return;
    case "response_completed":
      return;
  }
}

function appendText(
  content: ContentBlock[],
  type: "text" | "reasoning_summary",
  delta: string,
): void {
  const last = content.at(-1);
  if (last?.type === type) {
    content[content.length - 1] = { type, text: last.text + delta };
  } else {
    content.push({ type, text: delta });
  }
}

function appendMessage(transcript: Transcript, message: TranscriptMessage): Transcript {
  return {
    ...transcript,
    messages: [...transcript.messages, message],
  };
}

async function emitError(
  emit: (
    event: RuntimeEventPayload,
  ) => Promise<void>,
  category: ErrorCategory,
  message: string,
  retryable: boolean,
): Promise<void> {
  await emit({ type: "error", category, message, retryable });
}
