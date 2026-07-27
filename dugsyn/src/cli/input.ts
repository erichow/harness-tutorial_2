import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ReadLineOptions {
  readonly signal?: AbortSignal | undefined;
}

/** The entire process shares one implementation of this boundary. */
export interface InputController {
  readLine(prompt: string, options?: ReadLineOptions): Promise<string | null>;
  onInterrupt(handler: () => void): () => void;
  close(): void;
}

export interface NodeInputControllerOptions {
  readonly input?: Readable | undefined;
  readonly output?: Writable | undefined;
  readonly terminal?: boolean | undefined;
}

interface PendingRead {
  readonly resolve: (line: string | null) => void;
  readonly reject: (error: unknown) => void;
  detachAbort?: (() => void) | undefined;
}

/**
 * Owns the only readline.Interface used by the CLI. Tools and permission
 * handlers receive this controller instead of constructing readline again.
 */
export class NodeInputController implements InputController {
  readonly #readline: Interface;
  readonly #output: Writable;
  readonly #terminal: boolean;
  readonly #interruptHandlers = new Set<() => void>();
  readonly #lines: string[] = [];
  #pending: PendingRead | undefined;
  #closed = false;

  constructor(options: NodeInputControllerOptions = {}) {
    const input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#terminal = options.terminal ?? Boolean((this.#output as Writable & { isTTY?: boolean }).isTTY);
    this.#readline = createInterface({
      input,
      output: this.#output,
      terminal: this.#terminal,
    });
    this.#readline.on("line", (line) => {
      // A pipe may deliver the whole script before the next read starts. In a
      // TTY, however, an unsolicited line must never become a future approval.
      if (this.#pending === undefined && !this.#terminal) this.#lines.push(line);
      else this.#settle(line);
    });
    this.#readline.on("close", () => {
      this.#closed = true;
      if (this.#pending !== undefined) this.#settle(this.#lines.shift() ?? null);
    });
    this.#readline.on("SIGINT", () => {
      for (const handler of [...this.#interruptHandlers]) handler();
    });
  }

  async readLine(prompt: string, options: ReadLineOptions = {}): Promise<string | null> {
    if (this.#pending !== undefined) {
      throw new Error("Only one terminal read may be active at a time");
    }
    options.signal?.throwIfAborted();
    if (this.#closed && this.#lines.length === 0) return null;
    this.#output.write(prompt);
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return buffered;

    return await new Promise<string | null>((resolve, reject) => {
      const pending: PendingRead = { resolve, reject };
      this.#pending = pending;
      if (options.signal !== undefined) {
        const signal = options.signal;
        const abort = (): void => {
          if (this.#pending !== pending) return;
          this.#pending = undefined;
          pending.detachAbort?.();
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.detachAbort = () => signal.removeEventListener("abort", abort);
      }
    });
  }

  onInterrupt(handler: () => void): () => void {
    this.#interruptHandlers.add(handler);
    return () => this.#interruptHandlers.delete(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#readline.close();
  }

  #settle(line: string | null): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.detachAbort?.();
    pending.resolve(line);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "Operation cancelled");
}
