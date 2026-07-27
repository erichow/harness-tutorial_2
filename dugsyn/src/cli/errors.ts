/** An invalid CLI invocation or missing user-supplied runtime setting. */
export class CliUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliUsageError";
  }
}
