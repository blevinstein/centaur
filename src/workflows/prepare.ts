import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import {
  type CentaurConfig,
  type ContextPolicy,
  type Platform,
  PROVIDER_SETTINGS,
  platformSettings,
  slug,
  threadPlatform,
} from "../config/index.js";
import { CHAT_SERVER_NAME } from "../mcp/server-config.js";
import { threadKey } from "../thread-key.js";
import {
  type AttachmentDownloader,
  type PosterClient,
  readThread,
  type ThreadStore,
} from "./aws.js";
import {
  assertSingleConfigStyle,
  committedExecutionMode,
  parseConfigOrThrow,
  readConfigText,
  resolveRoot,
} from "./config-file.js";
import { type Instructions, loadInstructions } from "./instructions.js";
import {
  type ApprovalThread,
  approvalThread,
  askApprovals,
  NO_DROPPED,
  type SuspendableServers,
  withoutServers,
} from "./mcp-approval.js";
import { buildChatServerConfig, buildMcpConfig } from "./mcp-config.js";
import { enforceMcpPolicy, type McpPolicyDeps } from "./mcp-policy-check.js";
import { type CandidateDeps, listCandidates, type TargetDeps } from "./pr-target.js";
import {
  buildPrompt,
  type ExecutionMode,
  mcpApprovalSection,
  type PullRequestCandidate,
  projectFolderSection,
  replySchema,
  skillsSection,
} from "./prompt.js";
import {
  type PullRequestReader,
  pendingComments,
  renderComments,
  singleInlineThread,
  truncateDiff,
} from "./pull-request-comments.js";
import { clearReactions, type ReactionSource } from "./reactions.js";
import { installRepositoryInstructions } from "./repository-instructions.js";
import { doubleQuote, shellArg, singleQuote } from "./shell-arg.js";
import { installSkills } from "./skills.js";
import {
  type AttachmentPath,
  type ChatMessage,
  markerBefore,
  pendingMessages,
  planTurn,
  threadPolicy,
} from "./transcript.js";
import { boundTranscript } from "./transcript-budget.js";
import { writeOidcCredentials, writeTurnState } from "./turn-state.js";

export const TURN_DIR = ".centaur-turn";
export const PROMPT_FILE = `${TURN_DIR}/prompt.md`;
export const MCP_CONFIG_FILE = `${TURN_DIR}/mcp.json`;
export const ATTACHMENT_DIR = `${TURN_DIR}/attachments`;
export const MAX_PROMPT_IMAGES = 10;

/**
 * A comment turn's workspace is the untrusted pull request branch, so only the user source
 * (`$HOME/.claude`) loads; the project and local sources, which read the workspace's
 * `.claude/settings*.json`, skills and rules, do not.
 */
const COMMENT_SETTING_SOURCES = "--setting-sources user";
const CONSUMER_SKILLS_DIR = ".claude/skills";
const NEW_THREAD_ACK = "Started a new thread.";
const NEW_THREAD_OPENING = "Fresh thread. What would you like to do?";

const dispatchPayload = z.object({
  bot: slug,
  thread_id: z.string().min(1),
  message_id: z.string().min(1).optional(),
});

export type StartTarget =
  | { destination: string; platform: Platform; thread?: "persistent" }
  | { fromThreadId: string };

export interface TurnState {
  mode: "reply" | "start-thread" | "comment";
  bot: string;
  threadId?: string;
  pullRequest?: number;
  /** The inline comment thread (root comment ID) the reply belongs in, when there is just one. */
  replyTo?: number;
  promptName?: string;
  /** Where `finish` starts threads for the one reply, in order; the first is the primary thread. */
  start?: StartTarget[];
  policy: ContextPolicy;
  marker?: string;
  /** The thread `marker` was read from; `finish` stores it only when that thread is the primary one. */
  markerThreadId?: string;
  /** Written as the marker when the turn suspends and no marker exists, so the resume turn sees the same pending messages. */
  suspendMarker?: string;
  source?: ReactionSource;
  /** Pending servers the agent may suspend the turn for; absent when the turn never suspends. */
  suspend?: SuspendableServers;
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
  /** Where to read the operator's MCP policy; required to run any config with `mcp_servers`. */
  mcpPolicy?: McpPolicyDeps | undefined;
  /** Lets chat and scheduled turns list pull requests the agent may update. */
  targets?: TargetDeps | undefined;
  workspace: string;
  /** Where the turn state goes; must be outside the workspace. */
  stateDir: string;
  /** Directory holding the Centaur config, the instructions and the persona. Defaults to `workspace`. */
  configRoot?: string | undefined;
  /** The Centaur root under `configRoot`, relative to it; defaults to `.`. */
  root?: string | undefined;
  home: string;
  /** The repository's `skills/` folder; without it no built-in skill is installed. */
  skillsDir?: string | undefined;
  runId: string;
  env: Record<string, string | undefined>;
  promptName?: string | undefined;
  clientPayload: unknown;
  poster: PosterClient;
  /** OIDC token that proves the repository to the poster; masked by the caller. */
  fetchToken: () => Promise<string>;
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
  start?: StartTarget[];
  policy: ContextPolicy;
  marker?: string;
  markerThreadId?: string;
  suspendMarker?: string;
  source?: ReactionSource;
  prompt: string;
  /** Where an approval request for this turn is raised; absent when the turn has no thread. */
  approvalThread?: ApprovalThread | undefined;
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

/** The earlier messages the prompt shows, bounded by `context.transcript_max_chars`. */
const earlierTranscript = (config: CentaurConfig, show: boolean, earlier: ChatMessage[]) =>
  show
    ? boundTranscript(earlier, config.context.transcript_max_chars)
    : { messages: [], omitted: 0 };

/**
 * What a turn in an existing thread shows besides the pending messages: the session to resume,
 * or the bounded earlier transcript when the policy calls for it and no session exists.
 */
async function threadContext(
  deps: PrepareDeps,
  config: CentaurConfig,
  directory: string,
  input: {
    store: ThreadStore;
    messages: ChatMessage[];
    pending: ChatMessage[];
    policy: ContextPolicy;
  },
) {
  const { store, messages, pending, policy } = input;
  const resumeSessionId = policy === "resume" ? await store.restoreSession(directory) : undefined;
  const showHistory = policy === "transcript" || (policy === "resume" && !resumeSessionId);
  const pendingIds = new Set(pending.map((m) => m.id));
  const { messages: history, omitted } = earlierTranscript(
    config,
    showHistory,
    messages.filter((m) => !pendingIds.has(m.id)),
  );
  const attachmentPath = await loadAttachments(deps, [...history, ...pending]);
  return { resumeSessionId, history, omitted, attachmentPath };
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

type ScheduledPrompt = CentaurConfig["prompts"][string];

/**
 * The context of a `thread: persistent` prompt's first target: its bound thread's transcript, marker
 * and session. Undefined when the prompt is not persistent or the destination has no thread yet
 * (the first run starts empty). The thread's policy is the latest in-thread command, else the
 * prompt's own, since every run rewrites the stored policy from the prompt.
 */
async function persistentContext(
  deps: PrepareDeps,
  config: CentaurConfig,
  directory: string,
  prompt: ScheduledPrompt,
) {
  const [target] = prompt.targets;
  if (prompt.thread !== "persistent" || !target) return undefined;
  const token = await deps.fetchToken();
  const { threadId } = await deps.poster.call<{ threadId?: string }>({
    operation: "resolve-destination",
    token,
    bot: config.bot,
    platform: target.platform,
    name: target.destination,
    thread: "persistent",
  });
  if (!threadId) return undefined;
  const { messages } = await readThread(deps.poster, { token, bot: config.bot, threadId });
  const store = deps.storeFor(config.bot, threadId);
  const pending = pendingMessages(messages, await store.readMarker());
  const policy = threadPolicy(messages, prompt.context);
  return {
    threadId,
    policy,
    pending,
    marker: messages.at(-1)?.id,
    ...(await threadContext(deps, config, directory, { store, messages, pending, policy })),
  };
}

async function scheduledTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  instructions: Instructions,
  directory: string,
  name: string,
  rootDir: string,
  executionMode: ExecutionMode,
): Promise<Turn> {
  const prompt = config.prompts[name];
  if (!prompt) throw new Error(`The Centaur config defines no prompt named "${name}"`);
  const scheduledTask = await readFile(join(rootDir, prompt.file), "utf8");
  const persistent = await persistentContext(deps, config, directory, prompt);
  const targets = prTargetFlags(
    config,
    await existingTargets(deps, config, executionMode),
    executionMode,
  );
  return {
    mode: "start-thread",
    policy: persistent?.policy ?? prompt.context,
    start:
      prompt.thread === "persistent"
        ? prompt.targets.map((target) => ({ ...target, thread: "persistent" as const }))
        : prompt.targets,
    allowExisting: targets.allowExisting,
    approvalThread: persistent ? approvalThread(persistent.threadId, persistent.marker) : undefined,
    ...(persistent?.marker
      ? { marker: persistent.marker, markerThreadId: persistent.threadId }
      : {}),
    ...(persistent?.resumeSessionId ? { resumeSessionId: persistent.resumeSessionId } : {}),
    prompt: buildPrompt({
      scheduledTask,
      instructions,
      ...targets,
      history: persistent?.history,
      omitted: persistent?.omitted,
      messages: persistent?.pending,
      attachmentPath: persistent?.attachmentPath,
    }),
  };
}

async function chatTurn(
  deps: PrepareDeps,
  config: CentaurConfig,
  instructions: Instructions,
  directory: string,
  executionMode: ExecutionMode,
): Promise<Turn | undefined> {
  const payload = dispatchPayload.parse(deps.clientPayload);
  if (payload.bot !== config.bot) {
    throw new Error(
      `dispatch is for bot "${payload.bot}" but the Centaur config configures "${config.bot}"`,
    );
  }
  const threadId = payload.thread_id;
  const store = deps.storeFor(config.bot, threadId);
  const { messages, policy: storedPolicy } = await readThread(deps.poster, {
    token: await deps.fetchToken(),
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
    defaultPolicy: storedPolicy ?? config.context.default,
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
      const targets = prTargetFlags(
        config,
        await existingTargets(deps, config, executionMode),
        executionMode,
      );
      return {
        mode: "start-thread",
        policy: config.context.default,
        start: [{ fromThreadId: threadId }],
        approvalThread: approvalThread(threadId, payload.message_id ?? marker),
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
      const { resumeSessionId, history, omitted, attachmentPath } = await threadContext(
        deps,
        config,
        directory,
        { store, messages, pending: plan.pending, policy: plan.policy },
      );
      const settings = platformSettings(config, threadPlatform(threadId));
      const canStaySilent = settings.respond_to === "all";
      const targets = prTargetFlags(
        config,
        await existingTargets(deps, config, executionMode),
        executionMode,
      );
      return {
        mode: "reply",
        allowExisting: targets.allowExisting,
        threadId,
        approvalThread: approvalThread(threadId, payload.message_id ?? marker),
        policy: plan.policy,
        source,
        ...(marker ? { marker } : {}),
        ...(lastProcessed === undefined
          ? { suspendMarker: markerBefore(messages, lastProcessed) }
          : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(canStaySilent ? { canStaySilent } : {}),
        prompt: buildPrompt({
          canStaySilent,
          ...targets,
          chatTools: chatToolsEnabled(config),
          instructions,
          handle: settings.handle,
          history,
          omitted,
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
      `pull request is linked to bot "${resolved.bot}" but the Centaur config configures "${config.bot}"`,
    );
  }
  const threadId = resolved.threadId;
  const [details, all, { messages, policy: storedPolicy }] = await Promise.all([
    comment.github.details(comment.repository, comment.pullRequest),
    comment.github.comments(comment.repository, comment.pullRequest),
    readThread(deps.poster, { token, bot: config.bot, threadId }),
  ]);
  const authors = config.pull_requests.comment_authors;
  const pending = pendingComments(all, details.createdAt, authors);
  if (pending.length === 0) return undefined;

  const policy = threadPolicy(messages, storedPolicy ?? config.context.default);
  const { resumeSessionId, history, omitted, attachmentPath } = await threadContext(
    deps,
    config,
    directory,
    { store: deps.storeFor(config.bot, threadId), messages, pending: [], policy },
  );
  const diff =
    resumeSessionId !== undefined
      ? undefined
      : truncateDiff(await comment.github.diff(comment.repository, comment.pullRequest));
  const replyTo = singleInlineThread(pending);
  return {
    mode: "comment",
    threadId,
    approvalThread: approvalThread(threadId, messages.at(-1)?.id),
    branch: details.headRef,
    pullRequest: comment.pullRequest,
    policy,
    canStaySilent: true,
    allowExisting: false,
    ...(replyTo ? { replyTo } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    prompt: buildPrompt({
      history,
      omitted,
      attachmentPath,
      instructions,
      chatTools: chatToolsEnabled(config),
      ...prTargetFlags(config, NO_EXISTING_TARGETS, "pull_request"),
      pullRequest: {
        title: details.title,
        body: details.body,
        diff,
        comments: renderComments(all, pending, authors),
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
 * Lists the pull requests the agent may update; a `direct` turn has none. With none, or when GitHub or the poster fails
 * (a warning, never a failed turn), the prompt omits the section and the schema omits the field.
 */
async function existingTargets(
  deps: PrepareDeps,
  config: CentaurConfig,
  executionMode: ExecutionMode,
): Promise<ExistingTargets> {
  if (executionMode === "direct" || config.pull_requests.existing === "off" || !deps.targets) {
    return NO_EXISTING_TARGETS;
  }
  const candidateDeps: CandidateDeps = { ...deps.targets, bot: config.bot, poster: deps.poster };
  try {
    const candidates = await listCandidates(candidateDeps);
    return { allowExisting: candidates.length > 0, candidates };
  } catch (error) {
    console.warn(`::warning::Could not list pull requests to update: ${(error as Error).message}`);
    return NO_EXISTING_TARGETS;
  }
}

const prTargetFlags = (
  config: CentaurConfig,
  existing: ExistingTargets,
  executionMode: ExecutionMode,
) => ({
  executionMode,
  allowNewPr: config.pull_requests.comment_new,
  allowExisting: existing.allowExisting,
  candidates: existing.candidates,
});

const chatToolsEnabled = (config: CentaurConfig) => config.chat_tools.scope === "chat";

export function buildClaudeArgs(input: {
  config: CentaurConfig;
  persona: string | undefined;
  resumeSessionId: string | undefined;
  canStaySilent: boolean;
  mode: TurnState["mode"];
  allowExisting: boolean;
  executionMode?: ExecutionMode | undefined;
  suspendable?: string[] | undefined;
  chatTools?: boolean | undefined;
  /** Some skill is installed, so the `Skill` tool is allowed. */
  skills?: boolean | undefined;
  mcpConfig?: string | undefined;
}) {
  const { config, persona, resumeSessionId, canStaySilent, mode, allowExisting, mcpConfig } = input;
  const { executionMode } = input;
  const suspendable = input.suspendable ?? [];
  const allowNewPr = config.pull_requests.comment_new;
  const readRule = config.allowed_tools.includes("Read") ? [] : [`Read(./${TURN_DIR}/**)`];
  const chatRule = input.chatTools ? [`mcp__${CHAT_SERVER_NAME}__*`] : [];
  const skillRule = input.skills ? ["Skill"] : [];
  const tools = [...config.allowed_tools, ...readRule, ...chatRule, ...skillRule].join(",");
  return [
    `--model ${config.model}`,
    ...(config.effort ? [`--effort ${config.effort}`] : []),
    `--allowedTools ${doubleQuote(tools)}`,
    ...(mode === "comment" ? [COMMENT_SETTING_SOURCES] : []),
    `--max-turns ${config.max_turns}`,
    ...(config.max_budget_usd ? [`--max-budget-usd ${config.max_budget_usd}`] : []),
    `--json-schema ${singleQuote(JSON.stringify(replySchema({ canStaySilent, mode, allowNewPr, allowExisting, executionMode, suspendable })))}`,
    ...(mcpConfig ? [`--mcp-config ${shellArg(mcpConfig)}`] : []),
    ...(persona ? [`--append-system-prompt-file ${shellArg(persona)}`] : []),
    ...(resumeSessionId ? [`--resume ${shellArg(resumeSessionId)}`] : []),
  ].join(" ");
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

const PROJECT_GUIDES = ["AGENTS.md", "CLAUDE.md"];

const existing = async (dir: string, names: string[]) =>
  (
    await Promise.all(names.map(async (name) => ((await exists(join(dir, name))) ? name : "")))
  ).filter(Boolean);

export async function prepare(deps: PrepareDeps): Promise<PrepareOutputs> {
  const configRoot = deps.configRoot ?? deps.workspace;
  await assertSingleConfigStyle(configRoot, deps.root);
  const rootDir = await resolveRoot(configRoot, deps.root);
  const config = parseConfigOrThrow(await readConfigText(configRoot, deps.root));
  const approvals = await enforceMcpPolicy(config, deps.mcpPolicy);
  const mcp = buildMcpConfig(config.mcp_servers, deps.env);
  if (mcp.missingSecrets.length > 0) {
    throw new Error(
      `mcp_servers reference secrets that are not set in the turn step's env: ${mcp.missingSecrets.join(", ")}`,
    );
  }
  if (chatToolsEnabled(config) && CHAT_SERVER_NAME in config.mcp_servers) {
    throw new Error(
      `mcp_servers must not define "${CHAT_SERVER_NAME}", which chat_tools.scope: chat provides`,
    );
  }
  const directory = sessionDirectory(deps.home, deps.workspace);
  await mkdir(directory, { recursive: true });
  if (deps.promptName && deps.comment) {
    throw new Error("a turn is either a scheduled prompt or a pull request comment, not both");
  }
  const instructions = await loadInstructions(rootDir, config.instructions);
  const executionMode: ExecutionMode = deps.comment
    ? "pull_request"
    : await committedExecutionMode(configRoot, deps.root);
  const turn = deps.promptName
    ? await scheduledTurn(
        deps,
        config,
        instructions,
        directory,
        deps.promptName,
        rootDir,
        executionMode,
      )
    : deps.comment
      ? await commentTurn(deps, deps.comment, config, instructions, directory)
      : await chatTurn(deps, config, instructions, directory, executionMode);
  if (!turn) return skipped;
  const skills = await installSkills({
    home: deps.home,
    sourceDir: config.skills.builtin ? deps.skillsDir : undefined,
    consumerDir: config.skills.consumer ? join(rootDir, CONSUMER_SKILLS_DIR) : undefined,
    allowedTools: config.allowed_tools,
  });
  await installRepositoryInstructions({
    home: deps.home,
    repoDir: configRoot,
    rootDir: config.repository_instructions.enabled ? rootDir : undefined,
    maxBytes: config.repository_instructions.max_bytes,
  });
  const { dropped, notice, pendingServers } =
    approvals.length > 0
      ? await askApprovals(deps, config, approvals, turn.approvalThread)
      : NO_DROPPED;
  const kept = withoutServers(dropped, mcp.config.mcpServers, config.allowed_tools);
  const suspend: SuspendableServers | undefined =
    turn.mode === "reply" && turn.approvalThread && pendingServers.length > 0
      ? { thread: turn.approvalThread, servers: pendingServers }
      : undefined;

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
    ...(turn.markerThreadId ? { markerThreadId: turn.markerThreadId } : {}),
    ...(turn.suspendMarker ? { suspendMarker: turn.suspendMarker } : {}),
    ...(turn.source ? { source: turn.source } : {}),
    ...(suspend ? { suspend } : {}),
  };
  const projectFolder = relative(configRoot, rootDir);
  const guides = await existing(rootDir, PROJECT_GUIDES);
  await mkdir(join(deps.workspace, TURN_DIR), { recursive: true });
  await writeFile(
    join(deps.workspace, PROMPT_FILE),
    [
      turn.prompt,
      skillsSection(skills.builtin.length > 0),
      projectFolderSection(projectFolder, guides),
      mcpApprovalSection(notice, suspend !== undefined),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  await writeTurnState(deps.stateDir, state);
  const chatTools = Boolean(turn.threadId) && chatToolsEnabled(config);
  if (chatTools) await writeOidcCredentials(deps.stateDir, deps.env);
  const mcpServers = {
    ...kept.servers,
    ...(chatTools
      ? {
          [CHAT_SERVER_NAME]: buildChatServerConfig({
            env: deps.env,
            stateDir: deps.stateDir,
            chatTools: config.chat_tools,
          }),
        }
      : {}),
  };
  const hasMcpServers = Object.keys(mcpServers).length > 0;
  if (hasMcpServers) {
    await writeFile(join(deps.workspace, MCP_CONFIG_FILE), JSON.stringify({ mcpServers }), {
      mode: 0o600,
    });
  }

  const personaPath = join(rootDir, config.persona);
  const persona = (await exists(personaPath))
    ? deps.configRoot
      ? personaPath
      : relative(configRoot, personaPath)
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
      config: { ...config, allowed_tools: kept.allowedTools },
      persona,
      resumeSessionId: turn.resumeSessionId,
      canStaySilent: turn.canStaySilent === true,
      mode: turn.mode,
      allowExisting: turn.allowExisting,
      executionMode,
      suspendable: suspend?.servers.map(({ name }) => name),
      chatTools,
      skills: skills.builtin.length + skills.consumer.length > 0,
      mcpConfig: hasMcpServers ? MCP_CONFIG_FILE : undefined,
    }),
  };
}
