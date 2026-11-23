import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrepareDeps } from "../../src/workflows/prepare.js";
import { scannedRange } from "./chat-context-fixtures.js";
import {
  configText,
  createFakeAws,
  createWorkspace,
  type message,
  THREAD,
} from "./workflow-fixtures.js";

export async function setup(
  messages: ReturnType<typeof message>[],
  config = configText(),
  files: Record<string, string> = {},
  configFile = ".centaur.yml",
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "read") return { messages };
    if (request.operation === "start-thread") return { threadId: "telegram:-100:99" };
    if (request.operation === "list-threads")
      return { threads: [], scanned: scannedRange(null, true) };
    if (request.operation === "read-channel")
      return { messages: [], scanned: scannedRange(null, true) };
    return { messageId: "m" };
  });
  const { root, home, stateDir } = await createWorkspace({
    [configFile]: config,
    ".centaur/persona.md": "Be kind.",
    ".centaur/prompts/weekly.md": "Post this week's tasks.",
    ...files,
  });
  const deps = (overrides: Partial<PrepareDeps> = {}): PrepareDeps => ({
    workspace: root,
    stateDir,
    home,
    runId: "42",
    env: {},
    clientPayload: { bot: "sprout", thread_id: THREAD, message_id: "1" },
    poster: aws.poster,
    fetchToken: async () => "jwt",
    attachments: aws.attachments,
    storeFor: aws.storeFor,
    ...overrides,
  });
  const executionFile = join(root, "execution.json");
  const writeExecution = (entry: object) =>
    writeFile(executionFile, JSON.stringify([{ type: "system" }, { type: "result", ...entry }]));
  return { aws, root, home, stateDir, deps, executionFile, writeExecution };
}

export const CHAT_CONFIG = "chat_context: { scope: chat, max_threads: 7, max_messages: 30 }";

export const chatConfigText = (extra = "") => configText(`${CHAT_CONFIG}\n${extra}`);

export const POSTER_ENV = {
  CENTAUR_FUNCTION_NAME: "poster-fn",
  CENTAUR_OIDC_AUDIENCE: "centaur",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/?v=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_REGION: "us-east-1",
  PATH: "/usr/bin",
};
