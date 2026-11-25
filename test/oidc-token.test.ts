import { afterEach, describe, expect, it, vi } from "vitest";
import { oidcTokenFetcher } from "../src/workflows/oidc-token.js";
import { SafeError } from "../src/workflows/safe-error.js";

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test/?a=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-secret",
};

afterEach(() => vi.unstubAllGlobals());

describe("oidcTokenFetcher", () => {
  it("names the missing grant", async () => {
    await expect(oidcTokenFetcher({}, "aud")()).rejects.toThrow(SafeError);
  });

  it("reports the status of a rejected request", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    await expect(oidcTokenFetcher(env, "aud")()).rejects.toThrow("OIDC token request failed (403)");
  });

  it("reports only the network error code, never the bearer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const failure = oidcTokenFetcher(env, "aud")();
    await expect(failure).rejects.toThrow(new SafeError("OIDC token request failed (ENOTFOUND)"));
    await expect(failure).rejects.toBeInstanceOf(SafeError);
  });
});
