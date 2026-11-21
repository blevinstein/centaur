import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnState } from "../../src/workflows/prepare.js";
import { writeTurnState } from "../../src/workflows/turn-state.js";
import { createWorkspace } from "./workflow-fixtures.js";

export const RUN_URL = "https://github.com/o/r/actions/runs/42";

export const turnState = (overrides: Partial<TurnState> = {}): TurnState => ({
  mode: "reply",
  bot: "sprout",
  policy: "transcript",
  sessionDirectory: "/tmp/sessions",
  ...overrides,
});

export async function writePullRequestTurn(result: object) {
  const { root, stateDir } = await createWorkspace({});
  await writeTurnState(stateDir, turnState());
  const executionFile = join(root, "execution.json");
  await writeFile(executionFile, JSON.stringify([{ type: "result", ...result }]));
  return { root, stateDir, executionFile };
}
