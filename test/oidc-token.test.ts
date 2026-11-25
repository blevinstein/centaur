import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oidcTokenFetcher, savedOidcTokenFetcher } from "../src/workflows/oidc-token.js";
import { SafeError } from "../src/workflows/safe-error.js";
import { OIDC_CREDENTIALS_FILE_NAME } from "../src/workflows/turn-state.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

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

describe("savedOidcTokenFetcher", () => {
  const saveCredentials = (stateDir: string, saved: unknown) =>
    writeFile(join(stateDir, OIDC_CREDENTIALS_FILE_NAME), JSON.stringify(saved));

  it("reads the file on every call", async () => {
    const { stateDir } = await createWorkspace({});
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return Response.json({ value: "jwt" });
    });
    const fetchToken = savedOidcTokenFetcher(stateDir, "aud");

    await saveCredentials(stateDir, env);
    await fetchToken();
    await saveCredentials(stateDir, {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test/?a=2",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "other",
    });
    await fetchToken();

    expect(seen).toEqual([
      "https://token.test/?a=1&audience=aud Bearer bearer-secret",
      "https://token.test/?a=2&audience=aud Bearer other",
    ]);
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "{"],
    ["missing a variable", { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test/?a=1" }],
    ["null", null],
  ])("fails safely when the file is %s", async (_name, saved) => {
    const { stateDir } = await createWorkspace({});
    if (typeof saved === "string")
      await writeFile(join(stateDir, OIDC_CREDENTIALS_FILE_NAME), saved);
    else if (saved !== undefined) await saveCredentials(stateDir, saved);

    const failure = savedOidcTokenFetcher(stateDir, "aud")();

    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toThrow("OIDC credentials unavailable");
  });
});
