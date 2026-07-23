import { z } from "zod";

import type { RuntimeEvent } from "../runtime/events.js";
import type { TestRunSummary } from "../runtime/test-loop.js";

export const HOST_PROTOCOL_VERSION = 1 as const;

export const hostCommandSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
    type: z.literal("hello"),
    client: z.string().trim().min(1),
  }).strict(),
  z.object({
    protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
    type: z.literal("start_turn"),
    requestId: z.string().trim().min(1),
    prompt: z.string().refine((value) => value.trim().length > 0),
  }).strict(),
  z.object({
    protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
    type: z.literal("cancel_turn"),
    requestId: z.string().trim().min(1),
  }).strict(),
]);

export type HostCommand = z.infer<typeof hostCommandSchema>;

export type PublicRuntimeEvent =
  | Readonly<Pick<RuntimeEvent, "protocolVersion" | "sequence" | "timestamp" | "turnId" | "type">>
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "text_delta" | "reasoning_summary_delta";
      readonly delta: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "tool_call_started";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "tool_call_finished";
      readonly toolCallId: string;
      readonly status: "success" | "error";
      readonly errorCode?: string | undefined;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "permission_requested";
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "permission_decided";
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly decision: "allow" | "deny";
      readonly scope?: "once" | "session" | undefined;
      readonly reason: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens?: number | undefined;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "provider_request_started";
      readonly provider: string;
      readonly step: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "provider_response";
      readonly provider: string;
      readonly requestId: string;
      readonly finishReason: string;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "error";
      readonly category: "user" | "tool" | "provider" | "cancelled" | "internal";
      readonly retryable: boolean;
    }
  | {
      readonly protocolVersion: 1;
      readonly sequence: number;
      readonly timestamp: string;
      readonly turnId: string;
      readonly type: "turn_finished";
      readonly reason: "completed" | "max_steps" | "max_duration" | "max_tokens" | "cancelled" | "error";
      readonly tests?: TestRunSummary | undefined;
    };

export type HostEvent =
  | {
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
      readonly type: "ready";
      readonly server: "agent-code";
    }
  | {
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
      readonly type: "runtime_event";
      readonly requestId: string;
      readonly event: PublicRuntimeEvent;
    }
  | {
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
      readonly type: "turn_result";
      readonly requestId: string;
      readonly turnId: string;
      readonly reason: "completed" | "max_steps" | "max_duration" | "max_tokens" | "cancelled" | "error";
    }
  | {
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION;
      readonly type: "protocol_error";
      readonly requestId?: string | undefined;
      readonly code: "handshake_required" | "invalid_message" | "turn_active" | "no_active_turn";
      readonly message: string;
    };

/**
 * Removes tool input/output and error text before an event crosses an IDE/Web
 * transport boundary. Permission events retain their user-facing reason.
 */
export function toPublicRuntimeEvent(event: RuntimeEvent): PublicRuntimeEvent {
  switch (event.type) {
    case "tool_call_started": {
      const { call: _call, ...base } = event;
      return { ...base, toolCallId: event.call.id, toolName: event.call.name };
    }
    case "tool_call_finished": {
      const { result: _result, ...base } = event;
      return {
        ...base,
        toolCallId: event.result.toolCallId,
        status: event.result.status,
        ...(event.result.error === undefined
          ? {}
          : { errorCode: event.result.error.code }),
      };
    }
    case "error": {
      const { message: _message, ...safe } = event;
      return safe;
    }
    default:
      return event;
  }
}
