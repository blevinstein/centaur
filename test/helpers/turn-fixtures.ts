import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PosterRequest } from "../../src/lambda/poster.js";
import { finish } from "../../src/workflows/finish.js";
import type { PrepareDeps } from "../../src/workflows/prepare.js";
import { PROMPT_FILE, prepare } from "../../src/workflows/prepare.js";
import { scannedRange } from "./chat-context-fixtures.js";
import {
  configText,
  createFakeAws,
  createWorkspace,
  message,
  pullRequestLink,
  THREAD,
} from "./workflow-fixtures.js";

const PRIMARY_THREAD = "telegram:-100:99";

export async function setup(
  messages: ReturnType<typeof message>[],
  config = configText(),
  files: Record<string, string> = {},
  configFile = ".centaur.yml",
  startThread: (request: PosterRequest) => unknown = () => ({ threadId: PRIMARY_THREAD }),
  storedPolicy?: string,
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "read")
      return { messages, ...(storedPolicy ? { policy: storedPolicy } : {}) };
    if (request.operation === "start-thread") return startThread(request);
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

export const CHAT_CONFIG = "chat_tools: { scope: chat, max_threads: 7, max_messages: 30 }";

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

export const FAN_OUT_CONFIG = configText(
  "prompts: {weekly: {destination: {telegram: household, slack: garden}}}",
  "{}, slack: {}",
);

/** A start-thread handler that gives each platform its own thread and fails the listed platforms. */
export const fanOutThreads =
  (failing: string[] = []) =>
  (request: PosterRequest) => {
    const { platform } = request as { platform: string };
    if (failing.includes(platform)) throw new Error("secret plans");
    return { threadId: `${platform}:thread` };
  };

/** Prepares the fan-out prompt and starts `finish` without awaiting it, so a test can expect its failure. */
export async function runFanOut(failing: string[] = []) {
  const run = await setup([], FAN_OUT_CONFIG, {}, ".centaur.yml", fanOutThreads(failing));
  await prepare(run.deps({ promptName: "weekly", clientPayload: undefined }));
  await run.writeExecution({ structured_output: { reply: "Tasks", new_thread_title: "Week" } });
  const finishing = finish({
    stateDir: run.stateDir,
    executionFile: run.executionFile,
    pullRequestLink: pullRequestLink(8),
    poster: run.aws.poster,
    storeFor: run.aws.storeFor,
  });
  return { ...run, finishing };
}

/** The text of the message at `index` in `sizedMessages`: one distinct letter, `size` times. */
export const letters = (index: number, size: number) =>
  String.fromCharCode(97 + index).repeat(size);

/** Thread messages (at most 8 earlier ones) whose texts are `letters(index, size)`. */
export const sizedMessages = (sizes: number[]) =>
  sizes.map((size, index) => message(String(index + 1), letters(index, size)));

export const budgetConfig = (maxChars: number, chatTools = false) =>
  (chatTools ? chatConfigText : configText)(`context: { transcript_max_chars: ${maxChars} }`);

/**
 * A thread of earlier messages that were already processed (the marker sits on the last of them)
 * followed by one pending message.
 */
export async function budgetSetup(sizes: number[], config: string, pending = "question") {
  const run = await setup(
    [...sizedMessages(sizes), message(String(sizes.length + 1), pending)],
    config,
  );
  await run.aws.storeFor("sprout", THREAD).writeMarker(String(sizes.length));
  return run;
}

export const readPrompt = (root: string) => readFile(join(root, PROMPT_FILE), "utf8");
