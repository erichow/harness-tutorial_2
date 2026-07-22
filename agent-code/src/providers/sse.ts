import { ProviderError } from "./provider.js";

/** Decode data-only Server-Sent Events without buffering the whole response. */
export async function* decodeSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  if (body === null) {
    throw new ProviderError("Provider returned an empty streaming response");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = findEventBoundary(buffer);
        if (boundary === undefined) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = readData(block);
        if (data !== undefined) yield data;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const data = readData(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(
  value: string,
): { readonly index: number; readonly length: number } | undefined {
  const candidates = [
    { index: value.indexOf("\r\n\r\n"), length: 4 },
    { index: value.indexOf("\n\n"), length: 2 },
    { index: value.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);

  candidates.sort((left, right) => left.index - right.index);
  return candidates[0];
}

function readData(block: string): string | undefined {
  const data = block
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""));

  return data.length === 0 ? undefined : data.join("\n");
}
