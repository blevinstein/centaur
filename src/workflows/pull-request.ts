import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanBody, cleanTitle } from "./clean-text.js";
import { extractResult } from "./finish.js";
import { STATE_FILE, type TurnState } from "./prepare.js";

export { cleanBody, cleanTitle, MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "./clean-text.js";

const DEFAULT_TITLE = "Centaur agent changes";

export interface PullRequestDetails {
  title: string;
  body: string;
}

export interface PullRequestDeps {
  workspace: string;
  executionFile: string;
  runUrl: string;
}

const origin = (state: TurnState) =>
  state.promptName
    ? `Opened by the scheduled prompt \`${state.promptName}\` of bot \`${state.bot}\``
    : `Opened by a chat turn of bot \`${state.bot}\``;

export function pullRequestDetails(
  state: TurnState,
  runUrl: string,
  agent: { title?: string | undefined; body?: string | undefined } = {},
): PullRequestDetails {
  const fallbackTitle = state.promptName
    ? cleanTitle(`${DEFAULT_TITLE}: ${state.promptName}`)
    : DEFAULT_TITLE;
  const footer = `${origin(state)} in [this workflow run](${runUrl}).`;
  const description = cleanBody(agent.body);
  return {
    title: cleanTitle(agent.title) || fallbackTitle,
    body: description ? `${description}\n\n---\n\n${footer}` : footer,
  };
}

export async function describePullRequest(deps: PullRequestDeps) {
  const state = JSON.parse(await readFile(join(deps.workspace, STATE_FILE), "utf8")) as TurnState;
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
