import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import type { JsonObject } from "../protocol/json.js";
import { ProviderError } from "./provider.js";

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface StreamingHttpRequest {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike | undefined;
  readonly provider: string;
}

let cachedDefaultFetch: FetchLike | undefined;

/**
 * Node's built-in fetch does not automatically honor the conventional proxy
 * environment variables. Use Undici's environment-aware dispatcher when a
 * proxy is configured, while keeping the zero-configuration path on native
 * fetch.
 */
export function createDefaultFetch(
  env: NodeJS.ProcessEnv = process.env,
): FetchLike {
  if (!hasProxyConfiguration(env)) return globalThis.fetch.bind(globalThis);

  const httpProxy = proxyValue(env, "http_proxy", "HTTP_PROXY");
  const httpsProxy = proxyValue(env, "https_proxy", "HTTPS_PROXY");
  const noProxy = proxyValue(env, "no_proxy", "NO_PROXY");
  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  });

  return async (input, init) =>
    (await undiciFetch(input, {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}

export function hasProxyConfiguration(env: NodeJS.ProcessEnv): boolean {
  return (
    proxyValue(env, "http_proxy", "HTTP_PROXY") !== undefined ||
    proxyValue(env, "https_proxy", "HTTPS_PROXY") !== undefined
  );
}

function getDefaultFetch(): FetchLike {
  cachedDefaultFetch ??= createDefaultFetch();
  return cachedDefaultFetch;
}

function proxyValue(
  env: NodeJS.ProcessEnv,
  lowercaseName: string,
  uppercaseName: string,
): string | undefined {
  const value = env[lowercaseName] ?? env[uppercaseName];
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function postJsonStream(
  request: StreamingHttpRequest,
): Promise<Response> {
  const fetcher = request.fetch ?? getDefaultFetch();
  let response: Response;

  try {
    response = await fetcher(request.url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`${request.provider} request failed: ${message}`, {
      cause: error,
      retryable: true,
    });
  }

  if (!response.ok) {
    const requestId = readRequestId(response);
    const detail = await readErrorDetail(response);
    throw new ProviderError(
      `${request.provider} HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      {
        requestId,
        retryable: isRetryableStatus(response.status),
        status: response.status,
      },
    );
  }

  return response;
}

export function readRequestId(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  const text = (await response.text()).slice(0, 2_000);
  if (text.length === 0) return undefined;

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Fall back to the bounded response text.
  }
  return text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string") {
    throw new ProviderError(`${context} is missing string field ${field}`);
  }
  return value;
}

export function parseJsonObject(value: string, context: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ProviderError(`${context} contained invalid JSON arguments`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ProviderError(`${context} arguments must be a JSON object`);
  }
  // JSON.parse can only produce JSON values; the record check above excludes
  // arrays, primitives, and null from a tool's top-level input.
  return parsed as JsonObject;
}
