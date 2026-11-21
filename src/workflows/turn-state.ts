import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnState } from "./prepare.js";

const STATE_FILE_NAME = "state.json";

/**
 * Holds the turn state outside the workspace, which the agent can write. Later steps of the same
 * job read it back; the agent's file tools are confined to the workspace.
 */
export const turnStateDir = (env: Record<string, string | undefined> = process.env) =>
  join(env.RUNNER_TEMP || tmpdir(), "centaur-turn");

export async function writeTurnState(stateDir: string, state: TurnState) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, STATE_FILE_NAME), JSON.stringify(state), { mode: 0o600 });
}

export const readTurnState = async (stateDir: string) =>
  JSON.parse(await readFile(join(stateDir, STATE_FILE_NAME), "utf8")) as TurnState;
