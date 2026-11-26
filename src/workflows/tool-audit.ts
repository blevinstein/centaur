import { readFile } from "node:fs/promises";
import { extractToolCalls } from "./finish.js";
import { refusalFor } from "./tool-gate.js";
import { readToolPolicy } from "./turn-state.js";

/**
 * Re-evaluates every MCP call in the agent's execution file against the policy `prepare` saved and
 * throws when one would have been refused. It cannot stop a call; it makes a gate that did not run,
 * was disabled or failed open fail the turn. A turn with no saved policy has no servers to audit.
 */
export async function auditToolCalls(stateDir: string, executionFile: string) {
  const policy = await readToolPolicy(stateDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!policy) return;
  const refused = extractToolCalls(await readFile(executionFile, "utf8")).flatMap(
    ({ name, input }) => {
      const reason = refusalFor(policy, name, input);
      return reason === undefined ? [] : [`${name}: ${reason}`];
    },
  );
  if (refused.length > 0) {
    throw new Error(
      `the agent made MCP calls the operator policy refuses, so the tool gate did not stop them:\n${refused.join("\n")}`,
    );
  }
}
