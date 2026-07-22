import type {
  Provider,
  ProviderRequest,
  ProviderStreamEvent,
} from "./provider.js";

export interface MockWaitForAbort {
  readonly type: "wait_for_abort";
}

export type MockProviderEvent = ProviderStreamEvent | MockWaitForAbort;

export interface MockProviderResponse {
  readonly events: readonly MockProviderEvent[];
}

/** A deterministic provider for tests, examples, and offline development. */
export class MockProvider implements Provider {
  readonly requests: ProviderRequest[] = [];
  #nextResponse = 0;

  constructor(private readonly responses: readonly MockProviderResponse[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const response = this.responses[this.#nextResponse];
    this.#nextResponse += 1;

    if (response === undefined) {
      throw new Error(`MockProvider has no scripted response at index ${this.#nextResponse - 1}`);
    }

    for (const event of response.events) {
      if (event.type === "wait_for_abort") {
        await waitForAbort(request.signal);
        continue;
      }

      if (request.signal.aborted) {
        throw request.signal.reason;
      }

      yield event;
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
