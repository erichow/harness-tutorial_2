import { ZodError } from "zod";

import { transcriptSchemaV1 } from "../messages/schemas.js";
import type { Transcript } from "../messages/transcript.js";
import { runtimeEventSchema } from "../runtime/event-schemas.js";
import type { RuntimeEvent } from "../runtime/events.js";

export class ProtocolDecodeError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolDecodeError";
  }
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    throw new ProtocolDecodeError("Input is not valid JSON.", { cause: error });
  }
}

function readVersion(value: unknown, field: "schemaVersion" | "protocolVersion"): unknown {
  if (typeof value !== "object" || value === null || !(field in value)) {
    throw new ProtocolDecodeError(`Missing ${field}.`);
  }

  return (value as Record<string, unknown>)[field];
}

function describeValidationError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  }

  return String(error);
}

export function encodeTranscript(transcript: Transcript): string {
  return JSON.stringify(transcript);
}

export function decodeTranscript(serialized: string): Transcript {
  const value = parseJson(serialized);
  const version = readVersion(value, "schemaVersion");
  if (version !== 1) {
    throw new ProtocolDecodeError(`Unsupported transcript schemaVersion: ${String(version)}.`);
  }

  try {
    return transcriptSchemaV1.parse(value);
  } catch (error: unknown) {
    throw new ProtocolDecodeError(
      `Invalid transcript: ${describeValidationError(error)}`,
      { cause: error },
    );
  }
}

export function encodeRuntimeEvent(event: RuntimeEvent): string {
  return JSON.stringify(event);
}

export function decodeRuntimeEvent(serialized: string): RuntimeEvent {
  const value = parseJson(serialized);
  const version = readVersion(value, "protocolVersion");
  if (version !== 1) {
    throw new ProtocolDecodeError(`Unsupported runtime protocolVersion: ${String(version)}.`);
  }

  try {
    return runtimeEventSchema.parse(value);
  } catch (error: unknown) {
    throw new ProtocolDecodeError(
      `Invalid runtime event: ${describeValidationError(error)}`,
      { cause: error },
    );
  }
}
