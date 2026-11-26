import { vi } from "vitest";

/** A fetch that never answers and rejects only when its signal aborts. */
export const hangingFetch = () =>
  vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  ) as unknown as typeof fetch;

/** Makes every `AbortSignal.timeout` fire at once, so a hung call times out without waiting. */
export const expireTimeoutsImmediately = () =>
  vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
