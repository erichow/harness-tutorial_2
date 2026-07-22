import { Buffer } from "node:buffer";

export type OutputStream = "stdout" | "stderr";

interface OutputChunk {
  readonly stream: OutputStream;
  readonly start: number;
  readonly end: number;
  readonly bytes: Buffer;
}

export interface OutputPage {
  readonly text: string;
  readonly nextOffset?: number | undefined;
  readonly totalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
}

/**
 * Keeps a byte-bounded head and tail. Offsets refer to the combined arrival
 * order of stdout and stderr, so a cursor remains stable while output grows.
 */
export class BoundedProcessOutput {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  readonly #head: OutputChunk[] = [];
  readonly #tail: OutputChunk[] = [];
  #headBytes = 0;
  #tailBytes = 0;
  #totalBytes = 0;

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 2) {
      throw new RangeError("maxCaptureBytes must be an integer of at least 2");
    }
    this.#headLimit = Math.floor(maxBytes / 2);
    this.#tailLimit = maxBytes - this.#headLimit;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  append(stream: OutputStream, value: Buffer): void {
    if (value.byteLength === 0) return;
    const start = this.#totalBytes;
    this.#totalBytes += value.byteLength;

    if (this.#headBytes < this.#headLimit) {
      const length = Math.min(value.byteLength, this.#headLimit - this.#headBytes);
      this.#head.push({
        stream,
        start,
        end: start + length,
        bytes: Buffer.from(value.subarray(0, length)),
      });
      this.#headBytes += length;
    }

    this.#tail.push({
      stream,
      start,
      end: start + value.byteLength,
      bytes: Buffer.from(value),
    });
    this.#tailBytes += value.byteLength;
    this.#trimTail();
  }

  page(offset: number, maxTextBytes: number): OutputPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.#totalBytes) {
      throw new Error("Invalid or stale output cursor");
    }
    if (!Number.isInteger(maxTextBytes) || maxTextBytes < 128) {
      throw new RangeError("maxTextBytes must be at least 128");
    }

    const tailStart = this.#tail[0]?.start ?? this.#totalBytes;
    const headEnd = this.#head.at(-1)?.end ?? 0;
    let position = offset;
    let omitted = 0;
    if (position >= headEnd && position < tailStart) {
      omitted = tailStart - position;
      position = tailStart;
    }

    const chunks = position < headEnd ? this.#head : this.#tail;
    const rendered: Buffer[] = [];
    let renderedBytes = 0;
    let lastStream: OutputStream | undefined;
    const appendText = (text: string): boolean => {
      const bytes = Buffer.from(text, "utf8");
      if (renderedBytes + bytes.byteLength > maxTextBytes) return false;
      rendered.push(bytes);
      renderedBytes += bytes.byteLength;
      return true;
    };

    if (omitted > 0) {
      appendText(`[... ${omitted} output bytes omitted ...]\n`);
    }

    for (const chunk of chunks) {
      if (chunk.end <= position) continue;
      if (chunk.start > position) {
        const gap = chunk.start - position;
        if (!appendText(`[... ${gap} output bytes omitted ...]\n`)) break;
        omitted += gap;
        position = chunk.start;
      }
      const within = Math.max(0, position - chunk.start);
      if (lastStream !== chunk.stream) {
        const label = `[${chunk.stream}]\n`;
        if (!appendText(label)) break;
        lastStream = chunk.stream;
      }
      const remainingBudget = maxTextBytes - renderedBytes;
      if (remainingBudget <= 0) break;
      const available = chunk.bytes.subarray(within);
      const take = Math.min(available.byteLength, remainingBudget);
      if (take === 0) break;
      rendered.push(available.subarray(0, take));
      renderedBytes += take;
      position += take;
      if (take < available.byteLength) break;

      if (position === headEnd && headEnd < tailStart) {
        const gap = tailStart - position;
        if (!appendText(`\n[... ${gap} output bytes omitted ...]\n`)) break;
        omitted += gap;
        position = tailStart;
        lastStream = undefined;
        // The next page starts at the tail. Keeping pages single-range makes
        // the cursor exact without retaining unbounded output.
        break;
      }
    }

    const nextOffset = position < this.#totalBytes ? position : undefined;
    return {
      text: Buffer.concat(rendered).toString("utf8"),
      ...(nextOffset === undefined ? {} : { nextOffset }),
      totalBytes: this.#totalBytes,
      retainedBytes: this.#retainedBytes(),
      omittedBytes: Math.max(0, this.#totalBytes - this.#retainedBytes()),
    };
  }

  #trimTail(): void {
    while (this.#tailBytes > this.#tailLimit && this.#tail.length > 0) {
      const first = this.#tail[0];
      if (first === undefined) break;
      const remove = Math.min(first.bytes.byteLength, this.#tailBytes - this.#tailLimit);
      if (remove === first.bytes.byteLength) {
        this.#tail.shift();
      } else {
        this.#tail[0] = {
          stream: first.stream,
          start: first.start + remove,
          end: first.end,
          bytes: Buffer.from(first.bytes.subarray(remove)),
        };
      }
      this.#tailBytes -= remove;
    }
  }

  #retainedBytes(): number {
    const headEnd = this.#head.at(-1)?.end ?? 0;
    const tailStart = this.#tail[0]?.start ?? this.#totalBytes;
    const overlap = Math.max(0, headEnd - tailStart);
    return this.#headBytes + this.#tailBytes - overlap;
  }
}
