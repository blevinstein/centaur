import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnState } from "../../src/workflows/prepare.js";
import { STATE_FILE } from "../../src/workflows/prepare.js";
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
  const { root } = await createWorkspace({ [STATE_FILE]: JSON.stringify(turnState()) });
  const executionFile = join(root, "execution.json");
  await writeFile(executionFile, JSON.stringify([{ type: "result", ...result }]));
  return { root, executionFile };
}
