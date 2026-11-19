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
import { type Instructions, loadInstructions } from "./instructions.js";
import { buildMcpConfig } from "./mcp-config.js";
import { type CandidateDeps, listCandidates, type TargetDeps } from "./pr-target.js";
import { buildPrompt, type PullRequestCandidate, replySchema } from "./prompt.js";
import {
  type PullRequestReader,
  pendingComments,
  renderComments,
  singleInlineThread,
  truncateDiff,
} from "./pull-request-comments.js";
import { clearReactions, type ReactionSource } from "./reactions.js";
import {
  type AttachmentPath,
  type ChatMessage,
  pendingMessages,
  planTurn,
  threadPolicy,
} from "./transcript.js";

export const TURN_DIR = ".centaur-turn";
export const PROMPT_FILE = `${TURN_DIR}/prompt.md`;
export const STATE_FILE = `${TURN_DIR}/state.json`;
export const MCP_CONFIG_FILE = `${TURN_DIR}/mcp.json`;
export const ATTACHMENT_DIR = `${TURN_DIR}/attachments`;
export const MAX_PROMPT_IMAGES = 10;

const NEW_THREAD_ACK = "Started a new thread.";
const NEW_THREAD_OPENING = "Fresh thread. What would you like to do?";

const dispatchPayload = z.object({ bot: alias, thread_id: z.string().min(1) });

export type StartTarget = { destination: string } | { fromThreadId: string };

export interface TurnState {
  mode: "reply" | "start-thread" | "comment";
  bot: string;
  threadId?: string;
  pullRequest?: number;
  /** The inline comment thread (root comment ID) the reply belongs in, when there is just one. */
  replyTo?: number;
  promptName?: string;
  start?: StartTarget;
  policy: ContextPolicy;
  marker?: string;
  source?: ReactionSource;
  sessionDirectory: string;
}

/** Present when a pull request comment, not a chat message or a schedule, triggered the turn. */
export interface CommentDeps {
  pullRequest: number;
  repository: string;
  github: PullRequestReader;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

export interface PrepareDeps {
  comment?: CommentDeps | undefined;
  /** Lets chat and scheduled turns list pull requests the agent may update. */
  targets?: TargetDeps | undefined;
  workspace: string;
  /** Directory holding `.centaur.yml`, the instructions and the persona. Defaults to `workspace`. */
  configRoot?: string | undefined;
  home: string;
  runId: string;
  env: Record<string, string | undefined>;
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
  branch?: string;
  pullRequest?: number;
  replyTo?: number;
  start?: StartTarget;
  policy: ContextPolicy;
  marker?: string;
  source?: ReactionSource;
  prompt: string;
  resumeSessionId?: string;
  canStaySilent?: boolean;
  allowExisting: boolean;
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
  instructions: Instructions,
  name: string,
): Promise<Turn> {
  const prompt = config.prompts[name];
  if (!prompt) throw new Error(`.centaur.yml defines no prompt named "${name}"`);
  const scheduledTask = await readFile(join(deps.workspace, prompt.file), "utf8");
  const targets = prTargetFlags(config, await existingTargets(deps, config));
  return {
    mode: "start-thread",
    policy: prompt.context,
    start: { destination: prompt.destination },
    allowExisting: targets.allowExisting,
    prompt: buildPrompt({ scheduledTask, instructions, ...targets }),
  };
}

async function chatTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  instructions: Instructions,
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
      const targets = prTargetFlags(config, await existingTargets(deps, config));
      return {
        mode: "start-thread",
        policy: config.context.default,
        start: { fromThreadId: threadId },
        source,
        allowExisting: targets.allowExisting,
        prompt: buildPrompt({
          messages: plan.seed,
          attachmentPath,
          instructions,
          ...targets,
        }),
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
      const targets = prTargetFlags(config, await existingTargets(deps, config));
      return {
        mode: "reply",
        allowExisting: targets.allowExisting,
        threadId,
        policy: plan.policy,
        source,
        ...(marker ? { marker } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(canStaySilent ? { canStaySilent } : {}),
        prompt: buildPrompt({
          canStaySilent,
          ...targets,
          instructions,
          handle: config.handle,
          history,
          messages: plan.pending,
          attachmentPath,
        }),
      };
    }
  }
}

async function commentTurn(
  deps: PrepareDeps,
  comment: CommentDeps,
  config: CentaurConfig,
  instructions: Instructions,
  directory: string,
): Promise<Turn | undefined> {
  const token = await comment.fetchToken();
  comment.mask(token);
  const resolved = await deps.poster.call<
    { found: false } | { found: true; bot: string; threadId: string }
  >({
    operation: "resolve-pull-request",
    token,
    pullRequest: comment.pullRequest,
    withThreadId: true,
  });
  if (!resolved.found) return undefined;
  comment.mask(resolved.threadId);
  if (resolved.bot !== config.bot) {
    throw new Error(
      `pull request is linked to bot "${resolved.bot}" but .centaur.yml configures "${config.bot}"`,
    );
  }
  const threadId = resolved.threadId;
  const [details, all, { messages }] = await Promise.all([
    comment.github.details(comment.repository, comment.pullRequest),
    comment.github.comments(comment.repository, comment.pullRequest),
    deps.poster.call<{ messages: ChatMessage[] }>({
      operation: "read",
      bot: config.bot,
      threadId,
    }),
  ]);
  const pending = pendingComments(all, details.createdAt);
  if (pending.length === 0) return undefined;

  const policy = threadPolicy(messages, config.context.default);
  const resumeSessionId =
    policy === "resume"
      ? await deps.storeFor(config.bot, threadId).restoreSession(directory)
      : undefined;
  const hasSession = resumeSessionId !== undefined;
  const showHistory = policy === "transcript" || (policy === "resume" && !hasSession);
  const history = showHistory ? messages : [];
  const attachmentPath = await loadAttachments(deps, history);
  const diff = hasSession
    ? undefined
    : truncateDiff(await comment.github.diff(comment.repository, comment.pullRequest));
  const replyTo = singleInlineThread(pending);
  return {
    mode: "comment",
    threadId,
    branch: details.headRef,
    pullRequest: comment.pullRequest,
    policy,
    canStaySilent: true,
    allowExisting: false,
    ...(replyTo ? { replyTo } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    prompt: buildPrompt({
      history,
      attachmentPath,
      instructions,
      ...prTargetFlags(config, NO_EXISTING_TARGETS),
      pullRequest: {
        title: details.title,
        body: details.body,
        diff,
        comments: renderComments(all, pending),
      },
    }),
  };
}

interface ExistingTargets {
  allowExisting: boolean;
  candidates: PullRequestCandidate[];
}

const NO_EXISTING_TARGETS: ExistingTargets = { allowExisting: false, candidates: [] };

/**
 * Lists the pull requests the agent may update. With none, or when GitHub or the poster fails
 * (a warning, never a failed turn), the prompt omits the section and the schema omits the field.
 */
async function existingTargets(deps: PrepareDeps, config: CentaurConfig): Promise<ExistingTargets> {
  if (config.pull_requests.existing === "off" || !deps.targets) return NO_EXISTING_TARGETS;
  const candidateDeps: CandidateDeps = { ...deps.targets, bot: config.bot, poster: deps.poster };
  try {
    const candidates = await listCandidates(candidateDeps);
    return { allowExisting: candidates.length > 0, candidates };
  } catch (error) {
    console.warn(`::warning::Could not list pull requests to update: ${(error as Error).message}`);
    return NO_EXISTING_TARGETS;
  }
}

const prTargetFlags = (config: CentaurConfig, existing: ExistingTargets) => ({
  allowNewPr: config.pull_requests.comment_new,
  allowExisting: existing.allowExisting,
  candidates: existing.candidates,
});

export function buildClaudeArgs(input: {
  config: CentaurConfig;
  persona: string | undefined;
  resumeSessionId: string | undefined;
  canStaySilent: boolean;
  mode: TurnState["mode"];
  allowExisting: boolean;
  mcpConfig?: string | undefined;
}) {
  const { config, persona, resumeSessionId, canStaySilent, mode, allowExisting, mcpConfig } = input;
  const allowNewPr = config.pull_requests.comment_new;
  const readRule = config.allowed_tools.includes("Read") ? [] : [`Read(./${TURN_DIR}/**)`];
  const tools = [...config.allowed_tools, ...readRule].join(",");
  return [
    `--model ${config.model}`,
    ...(config.effort ? [`--effort ${config.effort}`] : []),
    `--allowedTools "${tools}"`,
    `--max-turns ${config.max_turns}`,
    ...(config.max_budget_usd ? [`--max-budget-usd ${config.max_budget_usd}`] : []),
    `--json-schema '${JSON.stringify(replySchema({ canStaySilent, mode, allowNewPr, allowExisting }))}'`,
    ...(mcpConfig ? [`--mcp-config ${mcpConfig}`] : []),
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
  const configRoot = deps.configRoot ?? deps.workspace;
  const config = parseConfigOrThrow(await readConfigText(configRoot));
  const mcp = buildMcpConfig(config.mcp_servers, deps.env);
  if (mcp.missingSecrets.length > 0) {
    throw new Error(
      `mcp_servers reference secrets that are not set in the turn step's env: ${mcp.missingSecrets.join(", ")}`,
    );
  }
  const hasMcpServers = Object.keys(config.mcp_servers).length > 0;
  const directory = sessionDirectory(deps.home, deps.workspace);
  await mkdir(directory, { recursive: true });
  if (deps.promptName && deps.comment) {
    throw new Error("a turn is either a scheduled prompt or a pull request comment, not both");
  }
  const instructions = await loadInstructions(configRoot, config.instructions);
  const turn = deps.promptName
    ? await scheduledTurn(deps, config, instructions, deps.promptName)
    : deps.comment
      ? await commentTurn(deps, deps.comment, config, instructions, directory)
      : await chatTurn(deps, config, instructions, directory);
  if (!turn) return skipped;

  const state: TurnState = {
    mode: turn.mode,
    bot: config.bot,
    policy: turn.policy,
    sessionDirectory: directory,
    ...(deps.promptName ? { promptName: deps.promptName } : {}),
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(turn.pullRequest ? { pullRequest: turn.pullRequest } : {}),
    ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
    ...(turn.start ? { start: turn.start } : {}),
    ...(turn.marker ? { marker: turn.marker } : {}),
    ...(turn.source ? { source: turn.source } : {}),
  };
  await mkdir(join(deps.workspace, TURN_DIR), { recursive: true });
  await writeFile(join(deps.workspace, PROMPT_FILE), turn.prompt);
  await writeFile(join(deps.workspace, STATE_FILE), JSON.stringify(state));
  if (hasMcpServers) {
    await writeFile(join(deps.workspace, MCP_CONFIG_FILE), JSON.stringify(mcp.config), {
      mode: 0o600,
    });
  }

  const personaPath = join(configRoot, config.persona);
  const persona = (await exists(personaPath))
    ? deps.configRoot
      ? personaPath
      : config.persona
    : undefined;
  return {
    skip: false,
    thread_id: turn.mode === "comment" ? "" : (turn.threadId ?? ""),
    branch:
      turn.branch ??
      `centaur/${config.bot}-${turn.threadId ? threadKey(config.bot, turn.threadId) : safeRef(`${deps.promptName ?? "new"}-${deps.runId}`)}`,
    base_url: PROVIDER_SETTINGS[config.provider].base_url ?? "",
    api_key_secret: PROVIDER_SETTINGS[config.provider].api_key_secret,
    claude_args: buildClaudeArgs({
      config,
      persona,
      resumeSessionId: turn.resumeSessionId,
      canStaySilent: turn.canStaySilent === true,
      mode: turn.mode,
      allowExisting: turn.allowExisting,
      mcpConfig: hasMcpServers ? MCP_CONFIG_FILE : undefined,
    }),
  };
}
