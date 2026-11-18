import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { alias, type CentaurConfig, type ContextPolicy } from "../config/index.js";
import type { PosterClient, ThreadStore } from "./aws.js";
import { parseConfigOrThrow, readConfigText } from "./config-file.js";
import { buildPrompt, REPLY_SCHEMA } from "./prompt.js";
import { type ChatMessage, planTurn } from "./transcript.js";

export const TURN_DIR = ".centaur-turn";
export const PROMPT_FILE = `${TURN_DIR}/prompt.md`;
export const STATE_FILE = `${TURN_DIR}/state.json`;

const NEW_THREAD_ACK = "Started a new thread.";
const NEW_THREAD_OPENING = "Fresh thread. What would you like to do?";
const MAX_TURNS = 30;

const dispatchPayload = z.object({ bot: alias, thread_id: z.string().min(1) });

export interface TurnState {
  mode: "reply" | "start-thread";
  bot: string;
  threadId?: string;
  policy: ContextPolicy;
  marker?: string;
  sessionDirectory: string;
}

export interface PrepareDeps {
  workspace: string;
  home: string;
  runId: string;
  promptName?: string | undefined;
  clientPayload: unknown;
  poster: PosterClient;
  storeFor: (bot: string, threadId: string) => ThreadStore;
}

export interface PrepareOutputs {
  skip: boolean;
  thread_id: string;
  branch: string;
  claude_args: string;
}

interface Turn {
  mode: TurnState["mode"];
  threadId?: string;
  policy: ContextPolicy;
  marker?: string;
  prompt: string;
  resumeSessionId?: string;
}

const safeRef = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, "-");

export const sessionDirectory = (home: string, workspace: string) =>
  join(home, ".claude", "projects", workspace.replaceAll(/[^A-Za-z0-9]/g, "-"));

const skipped: PrepareOutputs = { skip: true, thread_id: "", branch: "", claude_args: "" };

async function scheduledTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  name: string,
): Promise<Turn> {
  const prompt = config.prompts[name];
  if (!prompt) throw new Error(`.centaur.yml defines no prompt named "${name}"`);
  const scheduledTask = await readFile(join(deps.workspace, prompt.file), "utf8");
  return { mode: "start-thread", policy: prompt.context, prompt: buildPrompt({ scheduledTask }) };
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
  const plan = planTurn({
    messages,
    marker: await store.readMarker(),
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
      return undefined;
    case "new-thread": {
      await post(NEW_THREAD_ACK);
      await markProcessed();
      if (plan.seed.length === 0) {
        await deps.poster.call({
          operation: "start-thread",
          bot: config.bot,
          text: NEW_THREAD_OPENING,
        });
        return undefined;
      }
      return {
        mode: "start-thread",
        policy: config.context.default,
        prompt: buildPrompt({ messages: plan.seed }),
      };
    }
    case "reply": {
      const resumeSessionId =
        plan.policy === "resume" ? await store.restoreSession(directory) : undefined;
      const pendingIds = new Set(plan.pending.map((m) => m.id));
      const showHistory =
        plan.policy === "transcript" || (plan.policy === "resume" && !resumeSessionId);
      return {
        mode: "reply",
        threadId,
        policy: plan.policy,
        ...(marker ? { marker } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        prompt: buildPrompt({
          history: showHistory ? messages.filter((m) => !pendingIds.has(m.id)) : [],
          messages: plan.pending,
        }),
      };
    }
  }
}

export function buildClaudeArgs(input: {
  config: CentaurConfig;
  persona: string | undefined;
  resumeSessionId: string | undefined;
}) {
  const { config, persona, resumeSessionId } = input;
  const readRule = config.allowed_tools.includes("Read") ? [] : [`Read(./${TURN_DIR}/**)`];
  const tools = [...config.allowed_tools, ...readRule].join(",");
  return [
    ...(config.model ? [`--model ${config.model}`] : []),
    `--allowedTools "${tools}"`,
    `--max-turns ${MAX_TURNS}`,
    `--json-schema '${JSON.stringify(REPLY_SCHEMA)}'`,
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
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(turn.marker ? { marker: turn.marker } : {}),
  };
  await mkdir(join(deps.workspace, TURN_DIR), { recursive: true });
  await writeFile(join(deps.workspace, PROMPT_FILE), turn.prompt);
  await writeFile(join(deps.workspace, STATE_FILE), JSON.stringify(state));

  const persona = (await exists(join(deps.workspace, config.persona))) ? config.persona : undefined;
  return {
    skip: false,
    thread_id: turn.threadId ?? "",
    branch: `centaur/${config.bot}-${safeRef(turn.threadId ?? `${deps.promptName ?? "new"}-${deps.runId}`)}`,
    claude_args: buildClaudeArgs({ config, persona, resumeSessionId: turn.resumeSessionId }),
  };
}
