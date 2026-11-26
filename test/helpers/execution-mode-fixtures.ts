import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "shell-quote";
import { PROMPT_FILE } from "../../src/workflows/prepare.js";
import { DIRECT_EXECUTION } from "./config-fixtures.js";
import { configText } from "./workflow-fixtures.js";

export const DIRECT_CONFIG = configText(DIRECT_EXECUTION);
export const PULL_REQUEST_CONFIG = configText("execution: {mode: pull_request}");

/** Statements a pull_request chat prompt made before the execution mode section existed. */
export const LEGACY_PULL_REQUEST_STATEMENTS = [
  "You are replying in a chat thread on behalf of this repository.",
  "Do the work the messages ask for using your tools.",
  "Edit files in the working tree only; a pull request is opened for you afterwards.",
  "Write the reply concisely, for the people in the thread.",
  "When you edit files, write the pull request for a reviewer who has not read the chat: what changed and why.",
];

export const LEGACY_PR_TITLE =
  "One line under 100 characters summarizing the change; the pull request title, or the commit message for a comment turn. Set it whenever you edit files.";
export const LEGACY_PR_BODY =
  "Markdown pull request description for a reviewer who has not read the chat: what changed and why. Set it whenever you edit files.";

export const SECTION_HEADING = "# Execution mode";

export const flat = (text: string) => text.replaceAll(/\s+/g, " ");

export const readPromptText = async (root: string) =>
  flat(await readFile(join(root, PROMPT_FILE), "utf8"));

export const schemaOf = (claudeArgs: string) => {
  const tokens = parse(claudeArgs);
  return JSON.parse(tokens[tokens.indexOf("--json-schema") + 1] as string) as {
    properties: Record<string, { description: string }>;
  };
};
