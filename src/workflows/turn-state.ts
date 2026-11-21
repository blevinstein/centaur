import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyLayers } from "../config/mcp-policy.js";
import type { TurnState } from "./prepare.js";

const STATE_FILE_NAME = "state.json";
const TOOL_POLICY_FILE_NAME = "tool-policy.json";
const HOOK_SETTINGS_FILE_NAME = "hook-settings.json";

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

export interface ToolPolicyState {
  bot: string;
  layers: PolicyLayers;
}

export async function writeToolPolicy(stateDir: string, state: ToolPolicyState) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, TOOL_POLICY_FILE_NAME), JSON.stringify(state), { mode: 0o600 });
}

export const readToolPolicy = async (stateDir: string) =>
  JSON.parse(await readFile(join(stateDir, TOOL_POLICY_FILE_NAME), "utf8")) as ToolPolicyState;

export const hookSettingsPath = (stateDir: string) => join(stateDir, HOOK_SETTINGS_FILE_NAME);
