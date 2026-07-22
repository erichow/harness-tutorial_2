interface CursorPayload {
  readonly version: 1;
  readonly scope: string;
  readonly offset: number;
}

export function encodeCursor(scope: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, scope: string): number {
  if (cursor === undefined) return 0;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null ||
      (value as Partial<CursorPayload>).version !== 1 ||
      (value as Partial<CursorPayload>).scope !== scope ||
      !Number.isSafeInteger((value as Partial<CursorPayload>).offset) ||
      ((value as Partial<CursorPayload>).offset ?? -1) < 0
    ) {
      throw new Error("shape");
    }
    return (value as CursorPayload).offset;
  } catch (error) {
    throw new Error("Invalid or stale cursor", { cause: error });
  }
}

export function paginateLines(
  lines: readonly string[],
  offset: number,
  maxBytes: number,
  header: string,
): { readonly content: string; readonly nextOffset?: number | undefined } {
  if (offset > lines.length) throw new Error("Invalid or stale cursor");
  const selected: string[] = [header];
  let bytes = Buffer.byteLength(header, "utf8");
  let index = offset;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const nextBytes = Buffer.byteLength(`\n${line}`, "utf8");
    if (selected.length > 1 && bytes + nextBytes > maxBytes) break;
    if (selected.length === 1 && bytes + nextBytes > maxBytes) {
      const available = Math.max(0, maxBytes - bytes - Buffer.byteLength("\n…", "utf8"));
      selected.push(`${truncateUtf8(line, available)}…`);
      index += 1;
      break;
    }
    selected.push(line);
    bytes += nextBytes;
    index += 1;
  }
  return {
    content: selected.join("\n"),
    ...(index < lines.length ? { nextOffset: index } : {}),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
