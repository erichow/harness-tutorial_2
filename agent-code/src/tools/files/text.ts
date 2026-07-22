import { createHash } from "node:crypto";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface DecodedText {
  readonly text: string;
  readonly hasBom: boolean;
}

export function sha256(buffer: Uint8Array): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function decodeUtf8(buffer: Uint8Array): DecodedText {
  if (buffer.includes(0)) throw new Error("Binary files are not supported");
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  try {
    return { text: decoder.decode(hasBom ? buffer.subarray(3) : buffer), hasBom };
  } catch (error) {
    throw new Error("File is not valid UTF-8 text", { cause: error });
  }
}

export function encodeUtf8(text: string, hasBom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!hasBom) return body;
  const result = new Uint8Array(body.length + 3);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(body, 3);
  return result;
}

export function splitLines(text: string): {
  readonly lines: string[];
  readonly eol: "\n" | "\r\n";
  readonly trailingNewline: boolean;
} {
  const eol = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

export function joinLines(
  lines: readonly string[],
  eol: "\n" | "\r\n",
  trailingNewline: boolean,
): string {
  if (lines.length === 0) return "";
  return `${lines.join(eol)}${trailingNewline ? eol : ""}`;
}

export function clipLine(line: string, maxCharacters = 2_000): string {
  return line.length <= maxCharacters
    ? line
    : `${line.slice(0, maxCharacters)}… [line clipped]`;
}
