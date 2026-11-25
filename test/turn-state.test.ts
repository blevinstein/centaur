import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SafeError } from "../src/workflows/safe-error.js";
import {
  OIDC_CREDENTIALS_FILE_NAME,
  readOidcCredentials,
  writeOidcCredentials,
} from "../src/workflows/turn-state.js";
import { POSTER_ENV } from "./helpers/turn-fixtures.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: POSTER_ENV.ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: POSTER_ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
};

describe("OIDC credentials in the turn state directory", () => {
  it("writes them privately and reads them back", async () => {
    const { stateDir } = await createWorkspace({});
    const dir = join(stateDir, "turn");

    expect(await writeOidcCredentials(dir, { ...POSTER_ENV })).toBe(true);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, OIDC_CREDENTIALS_FILE_NAME))).mode & 0o777).toBe(0o600);
    expect(await readOidcCredentials(dir)).toEqual(OIDC_ENV);
    expect(await readFile(join(dir, OIDC_CREDENTIALS_FILE_NAME), "utf8")).not.toContain(
      "aws-secret",
    );
  });

  it("writes nothing without both variables", async () => {
    const { stateDir } = await createWorkspace({});

    expect(
      await writeOidcCredentials(stateDir, {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://t.example/?v=1",
      }),
    ).toBe(false);

    await expect(readOidcCredentials(stateDir)).rejects.toThrow(
      new SafeError("OIDC credentials unavailable"),
    );
  });
});
