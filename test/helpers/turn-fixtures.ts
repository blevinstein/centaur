import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildThreadId } from "../../src/config/index.js";
import type { PosterRequest } from "../../src/lambda/poster.js";
import { parseConfigOrThrow } from "../../src/workflows/config-file.js";
import { finish } from "../../src/workflows/finish.js";
import type { PrepareDeps } from "../../src/workflows/prepare.js";
import { PROMPT_FILE, prepare } from "../../src/workflows/prepare.js";
import { scheduleGroup } from "../../src/workflows/schedule-group.js";
import { scannedRange } from "./chat-context-fixtures.js";
import { yamlOf } from "./config-fixtures.js";
import {
  botMessage,
  configText,
  createFakeAws,
  createWorkspace,
  message,
  pullRequestLink,
  THREAD,
} from "./workflow-fixtures.js";

export const PRIMARY_THREAD = "telegram:-100:99";
export const BOUND_THREAD = "telegram:-100:55";
export const SLACK_THREAD = buildThreadId("slack", "C0123", "1700000000.000100");
export const prefixOf = (threadId: string) => `sessions/sprout/${threadId.replaceAll(":", "_")}/`;

export async function setup(
  messages: ReturnType<typeof message>[],
  config = configText(),
  files: Record<string, string> = {},
  configFile = ".centaur.yml",
  startThread: (request: PosterRequest) => unknown = () => ({ threadId: PRIMARY_THREAD }),
  storedPolicy?: string,
  resolveDestination: (request: PosterRequest) => unknown = () => ({ found: false }),
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "read")
      return { messages, ...(storedPolicy ? { policy: storedPolicy } : {}) };
    if (request.operation === "resolve-destination") return resolveDestination(request);
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

export const searchConfigText = () =>
  yamlOf({
    bot: "sprout",
    platforms: "{telegram: {}, slack: {}}",
    allowed_tools: "Read,Edit",
    chat_tools: "{scope: chat, slack_search: true}",
  });

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

/** Writes the agent's result for a prepared scheduled run and runs `finish`. */
export async function startFinish(
  run: Awaited<ReturnType<typeof setup>>,
  result: object = { structured_output: { reply: "Tasks", new_thread_title: "Week" } },
) {
  await run.writeExecution(result);
  return finish({
    stateDir: run.stateDir,
    executionFile: run.executionFile,
    pullRequestLink: pullRequestLink(8),
    poster: run.aws.poster,
    storeFor: run.aws.storeFor,
  });
}

/** Prepares a scheduled prompt (`weekly`) and starts `finish`, so a test can expect its failure. */
export async function runFanOut(failing: string[] = [], config = FAN_OUT_CONFIG) {
  const run = await setup([], config, {}, ".centaur.yml", fanOutThreads(failing));
  await prepareScheduled(run);
  return { ...run, finishing: startFinish(run) };
}

export const startThreadRequests = (aws: { requests: PosterRequest[] }) =>
  aws.requests.filter((request) => request.operation === "start-thread");

export const persistentConfig = (promptFields = "", extra = "") =>
  configText(
    `${extra}\nprompts: {weekly: {destination: household, thread: persistent${promptFields}}}`,
  );

export const PERSISTENT_FAN_OUT_CONFIG = configText(
  "prompts: {weekly: {thread: persistent, destination: {telegram: household, slack: garden}}}",
  "{}, slack: {}",
);

/** A `resolve-destination` handler for a destination that has `threadId` bound, or none yet. */
export const bindDestination = (threadId?: string) => () => ({
  chatId: "-100",
  ...(threadId ? { threadId } : {}),
});

/**
 * A scheduled run of the `weekly` prompt of `config` whose destination has `bound` as its
 * persistent thread; `start-thread` answers with `started`, by default `bound` or a new thread.
 */
export const scheduledSetup = (
  messages: ReturnType<typeof message>[],
  config: string,
  bound?: string,
  started = bound ?? PRIMARY_THREAD,
) =>
  setup(
    messages,
    config,
    {},
    ".centaur.yml",
    () => ({ threadId: started }),
    undefined,
    bindDestination(bound),
  );

export const prepareScheduled = (run: Awaited<ReturnType<typeof setup>>) =>
  prepare(run.deps({ promptName: "weekly", clientPayload: undefined }));

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

export const operationsOf = (aws: { requests: PosterRequest[] }) =>
  aws.requests.map((request) => request.operation);

export const RESOLVE_PERSISTENT = {
  operation: "resolve-destination",
  token: "jwt",
  bot: "sprout",
  platform: "telegram",
  name: "household",
  thread: "persistent",
};

/** An earlier run's post between a human question and a reply the run has not seen. */
export const EARLIER_RUN = [
  message("1", "first question"),
  botMessage("2", "last week's report"),
  message("3", "please add rain"),
];

export const scheduleGroupOf = (configYaml: string, runId = "42") =>
  scheduleGroup(parseConfigOrThrow(configYaml), "weekly", runId);

export const GARDEN = "apps/garden";

/** `files` placed under `folder`, the way a sub-folder Centaur root holds them. */
export const underFolder = (files: Record<string, string>, folder = GARDEN) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, text]));

/** A workspace whose Centaur files sit under `GARDEN` (`topFiles` sit at the repository top); `deps` already carries that root. */
export async function gardenSetup(
  messages: ReturnType<typeof message>[],
  config = configText(),
  files: Record<string, string> = {},
  topFiles: Record<string, string> = {},
) {
  const run = await setup(
    messages,
    config,
    { ...topFiles, ...underFolder({ ".centaur/persona.md": "Be green.", ...files }) },
    `${GARDEN}/.centaur.yml`,
  );
  return {
    ...run,
    deps: (overrides: Partial<PrepareDeps> = {}) => run.deps({ root: GARDEN, ...overrides }),
  };
}

/** A `storeFor` whose marker write or session save throws, for the steps that follow the reply. */
export const failingStore =
  (
    storeFor: ReturnType<typeof createFakeAws>["storeFor"],
    failing: "writeMarker" | "saveSession",
  ) =>
  (bot: string, threadId: string) => ({
    ...storeFor(bot, threadId),
    [failing]: async () => {
      throw new Error("s3 down");
    },
  });
