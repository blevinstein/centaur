import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnState } from "./prepare.js";
import { SafeError } from "./safe-error.js";

const STATE_FILE_NAME = "state.json";
export const OIDC_CREDENTIALS_FILE_NAME = "oidc-credentials.json";
const OIDC_VARIABLES = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"] as const;

/**
 * Holds the turn state outside the workspace, which the agent can write. Later steps of the same
 * job read it back; the agent's file tools are confined to the workspace.
 */
export const turnStateDir = (env: Record<string, string | undefined> = process.env) =>
  join(env.RUNNER_TEMP || tmpdir(), "centaur-turn");

async function writePrivateFile(stateDir: string, name: string, value: unknown) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, name), JSON.stringify(value), { mode: 0o600 });
}

export const writeTurnState = (stateDir: string, state: TurnState) =>
  writePrivateFile(stateDir, STATE_FILE_NAME, state);

/**
 * Saves the job's OIDC request URL and token for the chat server, whose environment the agent
 * action strips of them. Returns false, writing nothing, when the job has no OIDC grant.
 */
export async function writeOidcCredentials(
  stateDir: string,
  env: Record<string, string | undefined>,
) {
  if (!OIDC_VARIABLES.every((name) => env[name])) return false;
  await writePrivateFile(
    stateDir,
    OIDC_CREDENTIALS_FILE_NAME,
    Object.fromEntries(OIDC_VARIABLES.map((name) => [name, env[name]])),
  );
  return true;
}

/** Reads the saved OIDC variables as an environment-like object; every failure is a `SafeError`. */
export async function readOidcCredentials(stateDir: string) {
  const unavailable = new SafeError("OIDC credentials unavailable");
  const saved: unknown = await readFile(join(stateDir, OIDC_CREDENTIALS_FILE_NAME), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => {
      throw unavailable;
    });
  const values = saved as Record<string, unknown> | null;
  if (!OIDC_VARIABLES.every((name) => typeof values?.[name] === "string")) throw unavailable;
  return values as Record<(typeof OIDC_VARIABLES)[number], string>;
}

export const readTurnState = async (stateDir: string) =>
  JSON.parse(await readFile(join(stateDir, STATE_FILE_NAME), "utf8")) as TurnState;
