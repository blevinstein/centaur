import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  alias,
  type CentaurConfig,
  type ContextPolicy,
  PROVIDER_SETTINGS,
} from "../config/index.js";
import { threadKey } from "../thread-key.js";
import type { AttachmentDownloader, PosterClient, ThreadStore } from "./aws.js";
import { parseConfigOrThrow, readConfigText } from "./config-file.js";
import { buildPrompt, replySchema } from "./prompt.js";
import { clearReactions, type ReactionSource } from "./reactions.js";
import { type AttachmentPath, type ChatMessage, pendingMessages, planTurn } from "./transcript.js";

export const TURN_DIR = ".centaur-turn";
export const PROMPT_FILE = `${TURN_DIR}/prompt.md`;
export const STATE_FILE = `${TURN_DIR}/state.json`;
export const ATTACHMENT_DIR = `${TURN_DIR}/attachments`;
export const MAX_PROMPT_IMAGES = 10;

const NEW_THREAD_ACK = "Started a new thread.";
const NEW_THREAD_OPENING = "Fresh thread. What would you like to do?";

const dispatchPayload = z.object({ bot: alias, thread_id: z.string().min(1) });

export type StartTarget = { destination: string } | { fromThreadId: string };

export interface TurnState {
  mode: "reply" | "start-thread";
  bot: string;
  threadId?: string;
  promptName?: string;
  start?: StartTarget;
  policy: ContextPolicy;
  marker?: string;
  source?: ReactionSource;
  sessionDirectory: string;
}

export interface PrepareDeps {
  workspace: string;
  home: string;
  runId: string;
  promptName?: string | undefined;
  clientPayload: unknown;
  poster: PosterClient;
  attachments: AttachmentDownloader;
  storeFor: (bot: string, threadId: string) => ThreadStore;
}

export interface PrepareOutputs {
  skip: boolean;
  thread_id: string;
  branch: string;
  claude_args: string;
  base_url: string;
  api_key_secret: string;
}

interface Turn {
  mode: TurnState["mode"];
  threadId?: string;
  start?: StartTarget;
  policy: ContextPolicy;
  marker?: string;
  source?: ReactionSource;
  prompt: string;
  resumeSessionId?: string;
  canStaySilent?: boolean;
}

const localAttachment = (key: string) => `${ATTACHMENT_DIR}/${basename(key)}`;

/** Downloads the newest images among the messages the prompt will show. */
async function loadAttachments(deps: PrepareDeps, shown: ChatMessage[]): Promise<AttachmentPath> {
  const keys = shown.flatMap((m) => m.attachments).slice(-MAX_PROMPT_IMAGES);
  await Promise.all(
    keys.map((key) => deps.attachments.download(key, join(deps.workspace, localAttachment(key)))),
  );
  const loaded = new Set(keys);
  return (key) => (loaded.has(key) ? localAttachment(key) : undefined);
}

const safeRef = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, "-");

export const sessionDirectory = (home: string, workspace: string) =>
  join(home, ".claude", "projects", workspace.replaceAll(/[^A-Za-z0-9]/g, "-"));

const skipped: PrepareOutputs = {
  skip: true,
  thread_id: "",
  branch: "",
  claude_args: "",
  base_url: "",
  api_key_secret: "",
};

async function scheduledTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  name: string,
): Promise<Turn> {
  const prompt = config.prompts[name];
  if (!prompt) throw new Error(`.centaur.yml defines no prompt named "${name}"`);
  const scheduledTask = await readFile(join(deps.workspace, prompt.file), "utf8");
  return {
    mode: "start-thread",
    policy: prompt.context,
    start: { destination: prompt.destination },
    prompt: buildPrompt({ scheduledTask }),
  };
}

async function chatTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  directory: string,
): Promise<Turn | undefined> {
  const payload = dispatchPayload.parse(deps.clientPayload);
  if (payload.bot !== config.bot) {
    throw new Error(
      `dispatch is for bot "${payload.bot}" but .centaur.yml configures "${config.bot}"`,
    );
  }
  const threadId = payload.thread_id;
  const store = deps.storeFor(config.bot, threadId);
  const { messages } = await deps.poster.call<{ messages: ChatMessage[] }>({
    operation: "read",
    bot: config.bot,
    threadId,
  });
  const marker = messages.at(-1)?.id;
  const lastProcessed = await store.readMarker();
  const source: ReactionSource = {
    bot: config.bot,
    threadId,
    messageIds: pendingMessages(messages, lastProcessed).map((m) => m.id),
  };
  const plan = planTurn({
    messages,
    marker: lastProcessed,
    defaultPolicy: config.context.default,
  });
  const post = (text: string) =>
    deps.poster.call({ operation: "post", bot: config.bot, threadId, text });
  const markProcessed = async () => {
    if (marker) await store.writeMarker(marker);
  };

  switch (plan.kind) {
    case "skip":
      return undefined;
    case "ack":
      await post(`Context policy for this thread: ${plan.policy}.`);
      await markProcessed();
      await clearReactions(deps.poster, source);
      return undefined;
    case "new-thread": {
      await post(NEW_THREAD_ACK);
      await markProcessed();
      const attachmentPath = await loadAttachments(deps, plan.seed);
      if (plan.seed.length === 0) {
        await deps.poster.call({
          operation: "start-thread",
          bot: config.bot,
          fromThreadId: threadId,
          text: NEW_THREAD_OPENING,
        });
        await clearReactions(deps.poster, source);
        return undefined;
      }
      return {
        mode: "start-thread",
        policy: config.context.default,
        start: { fromThreadId: threadId },
        source,
        prompt: buildPrompt({ messages: plan.seed, attachmentPath }),
      };
    }
    case "reply": {
      const resumeSessionId =
        plan.policy === "resume" ? await store.restoreSession(directory) : undefined;
      const canStaySilent = config.respond_to === "all";
      const pendingIds = new Set(plan.pending.map((m) => m.id));
      const showHistory =
        plan.policy === "transcript" || (plan.policy === "resume" && !resumeSessionId);
      const history = showHistory ? messages.filter((m) => !pendingIds.has(m.id)) : [];
      const attachmentPath = await loadAttachments(deps, [...history, ...plan.pending]);
      return {
        mode: "reply",
        threadId,
        policy: plan.policy,
        source,
        ...(marker ? { marker } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(canStaySilent ? { canStaySilent } : {}),
        prompt: buildPrompt({
          canStaySilent,
          handle: config.handle,
          history,
          messages: plan.pending,
          attachmentPath,
        }),
      };
    }
  }
}

export function buildClaudeArgs(input: {
  config: CentaurConfig;
  persona: string | undefined;
  resumeSessionId: string | undefined;
  canStaySilent: boolean;
}) {
  const { config, persona, resumeSessionId, canStaySilent } = input;
  const readRule = config.allowed_tools.includes("Read") ? [] : [`Read(./${TURN_DIR}/**)`];
  const tools = [...config.allowed_tools, ...readRule].join(",");
  return [
    `--model ${config.model}`,
    ...(config.effort ? [`--effort ${config.effort}`] : []),
    `--allowedTools "${tools}"`,
    `--max-turns ${config.max_turns}`,
    ...(config.max_budget_usd ? [`--max-budget-usd ${config.max_budget_usd}`] : []),
    `--json-schema '${JSON.stringify(replySchema(canStaySilent))}'`,
    ...(persona ? [`--append-system-prompt-file ${persona}`] : []),
    ...(resumeSessionId ? [`--resume ${resumeSessionId}`] : []),
  ].join(" ");
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

export async function prepare(deps: PrepareDeps): Promise<PrepareOutputs> {
  const config = parseConfigOrThrow(await readConfigText(deps.workspace));
  const directory = sessionDirectory(deps.home, deps.workspace);
  await mkdir(directory, { recursive: true });
  const turn = deps.promptName
    ? await scheduledTurn(deps, config, deps.promptName)
    : await chatTurn(deps, config, directory);
  if (!turn) return skipped;

  const state: TurnState = {
    mode: turn.mode,
    bot: config.bot,
    policy: turn.policy,
    sessionDirectory: directory,
    ...(deps.promptName ? { promptName: deps.promptName } : {}),
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(turn.start ? { start: turn.start } : {}),
    ...(turn.marker ? { marker: turn.marker } : {}),
    ...(turn.source ? { source: turn.source } : {}),
  };
  await mkdir(join(deps.workspace, TURN_DIR), { recursive: true });
  await writeFile(join(deps.workspace, PROMPT_FILE), turn.prompt);
  await writeFile(join(deps.workspace, STATE_FILE), JSON.stringify(state));

  const persona = (await exists(join(deps.workspace, config.persona))) ? config.persona : undefined;
  return {
    skip: false,
    thread_id: turn.threadId ?? "",
    branch: `centaur/${config.bot}-${turn.threadId ? threadKey(config.bot, turn.threadId) : safeRef(`${deps.promptName ?? "new"}-${deps.runId}`)}`,
    base_url: PROVIDER_SETTINGS[config.provider].base_url ?? "",
    api_key_secret: PROVIDER_SETTINGS[config.provider].api_key_secret,
    claude_args: buildClaudeArgs({
      config,
      persona,
      resumeSessionId: turn.resumeSessionId,
      canStaySilent: turn.canStaySilent === true,
    }),
  };
}
