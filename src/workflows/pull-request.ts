import { readFile } from "node:fs/promises";
import { cleanBody, cleanTitle } from "./clean-text.js";
import { extractResult } from "./finish.js";
import type { TurnState } from "./prepare.js";
import { readTurnState } from "./turn-state.js";

export { cleanBody, cleanTitle, MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "./clean-text.js";

const DEFAULT_TITLE = "Centaur agent changes";

export interface PullRequestDetails {
  title: string;
  body: string;
}

export interface PullRequestDeps {
  stateDir: string;
  executionFile: string;
  runUrl: string;
}

const origin = (state: TurnState, verb: string) =>
  state.promptName
    ? `${verb} by the scheduled prompt \`${state.promptName}\` of bot \`${state.bot}\``
    : `${verb} by a chat turn of bot \`${state.bot}\``;

export function pullRequestDetails(
  state: TurnState,
  runUrl: string,
  agent: { title?: string | undefined; body?: string | undefined } = {},
  verb = "Opened",
): PullRequestDetails {
  const fallbackTitle = state.promptName
    ? cleanTitle(`${DEFAULT_TITLE}: ${state.promptName}`)
    : DEFAULT_TITLE;
  const footer = `${origin(state, verb)} in [this workflow run](${runUrl}).`;
  const description = cleanBody(agent.body);
  return {
    title: cleanTitle(agent.title) || fallbackTitle,
    body: description ? `${description}\n\n---\n\n${footer}` : footer,
  };
}

export async function describePullRequest(deps: PullRequestDeps) {
  const state = await readTurnState(deps.stateDir);
  const agent = await readFile(deps.executionFile, "utf8").then(
    (text) => {
      try {
        const { prTitle, prBody } = extractResult(text);
        return { title: prTitle, body: prBody };
      } catch {
        return {};
      }
    },
    () => ({}),
  );
  return pullRequestDetails(state, deps.runUrl, agent);
}
