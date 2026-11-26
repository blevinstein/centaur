import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubDispatcher } from "../src/lambda/github.js";
import { REQUEST_TIMEOUT_MS } from "../src/lambda/request-timeout.js";
import { createTelegramApi } from "../src/lambda/telegram.js";
import { expireTimeoutsImmediately, hangingFetch } from "./helpers/timeout-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("outbound request timeouts", () => {
  it.each([
    [
      "the GitHub dispatch",
      (fetchImpl: typeof fetch) =>
        createGitHubDispatcher("t", fetchImpl).dispatch("octo/garden", "event", {}),
    ],
    ["a Telegram call", (fetchImpl: typeof fetch) => createTelegramApi(fetchImpl).getMe("token")],
  ])("%s fails with a timeout error instead of hanging", async (_name, call) => {
    const timeout = expireTimeoutsImmediately();

    await expect(call(hangingFetch())).rejects.toMatchObject({ name: "TimeoutError" });

    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });
});
