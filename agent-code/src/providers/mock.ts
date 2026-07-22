import type {
  Provider,
  ProviderRequest,
  ProviderResponseCompleted,
  ProviderStreamEvent,
} from "./provider.js";

export interface MockWaitForAbort {
  readonly type: "wait_for_abort";
}

type MockResponseCompleted = Omit<
  ProviderResponseCompleted,
  "requestId" | "providerFinishReason"
> &
  Partial<Pick<ProviderResponseCompleted, "requestId" | "providerFinishReason">>;

export type MockProviderEvent =
  | Exclude<ProviderStreamEvent, ProviderResponseCompleted>
  | MockResponseCompleted
  | MockWaitForAbort;

export interface MockProviderResponse {
  readonly events: readonly MockProviderEvent[];
}

export type MockProviderStep =
  | MockProviderResponse
  | ((request: ProviderRequest) => MockProviderResponse | Promise<MockProviderResponse>);

/** A deterministic provider for tests, examples, and offline development. */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly requests: ProviderRequest[] = [];
  #nextResponse = 0;

  constructor(private readonly responses: readonly MockProviderStep[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const step = this.responses[this.#nextResponse];
    this.#nextResponse += 1;

    if (step === undefined) {
      throw new Error(`MockProvider has no scripted response at index ${this.#nextResponse - 1}`);
    }
    const response = typeof step === "function" ? await step(request) : step;

    for (const event of response.events) {
      if (event.type === "wait_for_abort") {
        await waitForAbort(request.signal);
        continue;
      }

      if (request.signal.aborted) {
        throw request.signal.reason;
      }

      if (event.type === "response_completed") {
        yield {
          ...event,
          requestId: event.requestId ?? `mock-response-${this.#nextResponse - 1}`,
          providerFinishReason: event.providerFinishReason ?? event.finishReason,
        };
      } else {
        yield event;
      }
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
