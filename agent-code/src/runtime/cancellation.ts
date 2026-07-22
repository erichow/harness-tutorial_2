export class TurnCancelledError extends Error {
  constructor(message = "Turn cancelled", options?: ErrorOptions) {
    super(message, options);
    this.name = "TurnCancelledError";
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;

  const reason = signal.reason;
  if (reason instanceof TurnCancelledError) throw reason;
  if (reason instanceof Error) {
    throw new TurnCancelledError(reason.message, { cause: reason });
  }
  throw new TurnCancelledError();
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof TurnCancelledError;
}
