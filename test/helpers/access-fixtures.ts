import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import type { Platform } from "../../src/config/index.js";
import { createAccessResolver } from "../../src/lambda/access.js";
import { createAccessDecisions } from "../../src/lambda/access-decisions.js";
import { adminParameter, encodeEntry } from "../../src/lambda/access-entries.js";
import {
  type AccessRequestLimits,
  createAccessRequestStore,
} from "../../src/lambda/access-request-store.js";
import {
  createAccessRequester,
  createApproverRequester,
  createMcpApprovalRequester,
  type McpApprovalInput,
} from "../../src/lambda/access-requests.js";
import { telegramAdminChannel } from "../../src/lambda/admin-channel.js";
import { encodeClaim } from "../../src/lambda/admin-claim-record.js";
import { createAdminClaimer } from "../../src/lambda/admin-claims.js";
import { registerAdminHandlers } from "../../src/lambda/admin-handlers.js";
import { type ApprovalState, showApprovalState } from "../../src/lambda/approval-reactions.js";
import { createApproverCommand } from "../../src/lambda/approver-commands.js";
import {
  approvedParameter,
  approverParameter,
  blockedParameter,
} from "../../src/lambda/connection-paths.js";
import {
  DEFAULT_FAILURE_NOTICE_MINUTES,
  withFailureNotice,
} from "../../src/lambda/dispatch-failure-notice.js";
import { createMessageHandler } from "../../src/lambda/message-handler.js";
import { ownershipSettings } from "./ownership-fixtures.js";
import {
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeMessage,
  fakeParameterStore,
  fakeThread,
  GARDEN_BOT,
  noSearchTokens,
  PARAMETERS,
  SLACK_BOT,
  STRANGER_USER_ID,
} from "./receiver-fixtures.js";
import { noThreadMeta } from "./thread-meta-fixtures.js";

const { "/centaur/chats/telegram/household": _household, ...ACCESS_PARAMETERS } = PARAMETERS;

export const ADMIN_ID = "5001";
export const dmMessageId = (requestId: string) => `dm-${requestId}`;
export const dmChannelId = (userId: string) => `telegram:${userId}`;
export const ADMIN_PARAMETER = "/centaur/admin/telegram";

const requestIdIn = (text: string) => /Access request (\w+)/.exec(text)?.[1] as string;

export async function accessHarness({
  admin = ADMIN_ID,
  limits,
  dmFails = false,
  failingUsers = [],
  messageIds,
  approvers = [],
}: {
  admin?: string | null;
  limits?: Partial<AccessRequestLimits>;
  dmFails?: boolean;
  failingUsers?: string[];
  messageIds?: string[];
  approvers?: string[];
} = {}) {
  const state = createMemoryState();
  await state.connect();
  const params = fakeParameterStore({
    ...ACCESS_PARAMETERS,
    ...(admin ? { [ADMIN_PARAMETER]: admin } : {}),
    ...approverEntries(GARDEN_BOT, approvers),
  });
  const store = createAccessRequestStore(state, {
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    perHour: 10,
    ...limits,
  });
  const queuedIds = [...(messageIds ?? [])];
  const adminPost = vi.fn(async ({ raw }: { raw: string }) => ({
    id: queuedIds.shift() ?? dmMessageId(requestIdIn(raw)),
  }));
  const messenger = {
    openDM: vi.fn(async (userId: string) => {
      if (dmFails || failingUsers.includes(userId)) throw new Error("chat not found");
      return { channelId: dmChannelId(userId), post: adminPost };
    }),
  };
  const logger = fakeLogger();
  const requestAccess = createAccessRequester({
    bot: GARDEN_BOT,
    params,
    store,
    channel: telegramAdminChannel,
    messenger,
    logger,
  });
  const requestMcp = createMcpApprovalRequester({
    bot: GARDEN_BOT,
    params,
    store,
    channel: telegramAdminChannel,
    messenger,
    logger,
  });
  const dispatcher = fakeDispatcher();
  const noticeDispatcher = withFailureNotice(dispatcher, {
    bot: GARDEN_BOT,
    intervalMs: DEFAULT_FAILURE_NOTICE_MINUTES * 60_000,
    params,
    state,
    channel: telegramAdminChannel,
    messenger,
    logger,
  });
  const invalidateAccess = vi.fn();
  const postToThread = vi.fn(async (_threadId: string, _text: string) => ({}));
  const reactions = {
    addReaction: vi.fn(async (..._args: unknown[]) => {}),
    removeReaction: vi.fn(async (..._args: unknown[]) => {}),
  };
  const showApproval = (threadId: string, messageId: string, state: ApprovalState) =>
    showApprovalState({
      adapter: reactions,
      bot: GARDEN_BOT,
      threadId,
      messageId,
      state,
      logger,
    });
  const decisions = createAccessDecisions({
    bot: GARDEN_BOT,
    params,
    store,
    channel: telegramAdminChannel,
    invalidateAccess,
    postToThread,
    showApproval,
    dispatcher: noticeDispatcher,
    logger,
  });
  const adminText = (index = 0) => adminPost.mock.calls[index]?.[0].raw ?? "";
  const requestId = (index = 0) => requestIdIn(adminText(index));
  const linkedRequestId = (userId = ADMIN_ID, messageId = dmMessageId(requestId())) =>
    store.requestIdForMessage({ channelId: dmChannelId(userId), messageId });
  const reaction = (
    rawEmoji: string,
    overrides: {
      userId?: string;
      messageId?: string;
      channelId?: string;
      added?: boolean;
      isDM?: boolean;
    } = {},
  ) => ({
    added: overrides.added ?? true,
    rawEmoji,
    messageId: overrides.messageId ?? dmMessageId(requestId()),
    user: { userId: overrides.userId ?? admin ?? ADMIN_ID },
    thread: {
      isDM: overrides.isDM ?? true,
      channelId: overrides.channelId ?? dmChannelId(overrides.userId ?? admin ?? ADMIN_ID),
    },
  });
  return {
    state,
    store,
    params,
    messenger,
    adminPost,
    adminText,
    requestId,
    linkedRequestId,
    logger,
    requestAccess,
    requestMcp,
    dispatcher,
    decisions,
    invalidateAccess,
    postToThread,
    reactions,
    reaction,
  };
}

export const CLAIM_CODE = "correct-horse_battery-staple";
export const CLAIM_PARAMETER = "/centaur/admin-claim/telegram";
export const SLACK_CLAIM_PARAMETER = "/centaur/admin-claim/slack";
export const CLAIMER_ID = "7777";

export async function claimHarness({
  bot = GARDEN_BOT,
  claimedBot = bot.name,
  expiresInMs = 60_000,
  claim = true,
}: {
  bot?: typeof GARDEN_BOT;
  claimedBot?: string;
  expiresInMs?: number;
  claim?: boolean;
} = {}) {
  const state = createMemoryState();
  await state.connect();
  const parameter = bot === SLACK_BOT ? SLACK_CLAIM_PARAMETER : CLAIM_PARAMETER;
  const params = fakeParameterStore({
    ...PARAMETERS,
    ...(claim
      ? { [parameter]: encodeClaim(claimedBot, CLAIM_CODE, new Date(Date.now() + expiresInMs)) }
      : {}),
  });
  const invalidateAccess = vi.fn();
  const logger = fakeLogger();
  const claimAdmin = createAdminClaimer({ bot, params, state, invalidateAccess, logger });
  const attempt = (code: string, overrides: { isDM?: boolean; userId?: string } = {}) =>
    claimAdmin({ userId: overrides.userId ?? CLAIMER_ID, isDM: overrides.isDM ?? true, code });
  return { params, state, parameter, invalidateAccess, logger, claimAdmin, attempt };
}

export const MCP_FINGERPRINT = "0123456789abcdef";
export const MCP_SUBJECT = `linear:${MCP_FINGERPRINT}`;
export const MCP_APPROVAL_PARAMETER = `/centaur/bots/garden/mcp-approvals/linear/${MCP_FINGERPRINT}`;
export const MCP_THREAD_ID = "telegram:-100500:7";
export const MCP_MESSAGE_ID = "telegram:-100500:812";

export const mcpInput = (overrides: Partial<McpApprovalInput> = {}): McpApprovalInput => ({
  name: "linear",
  fingerprint: MCP_FINGERPRINT,
  summary: "http https://mcp.example.com/mcp, secrets LINEAR_TOKEN",
  threadId: MCP_THREAD_ID,
  messageId: MCP_MESSAGE_ID,
  ...overrides,
});

export async function mcpHarness(
  options: Parameters<typeof accessHarness>[0] = {},
  input: Partial<McpApprovalInput> = {},
) {
  const h = await accessHarness(options);
  const outcome = await h.requestMcp(mcpInput(input));
  return { ...h, outcome };
}

/** An `mcp` request with its pending slot linked and, optionally, its decision claimed. */
export async function strandedMcpSlot(
  h: Pick<Awaited<ReturnType<typeof accessHarness>>, "store">,
  { decided = false }: { decided?: boolean } = {},
) {
  const request = await h.store.create({
    kind: "mcp",
    subjectId: MCP_SUBJECT,
    subjectName: "linear",
    threadId: MCP_THREAD_ID,
  });
  await h.store.claimSubject("mcp", MCP_SUBJECT);
  await h.store.linkSubject(request);
  if (decided) await h.store.claimDecision(request.id, "approve");
  return request;
}

export const APPROVER_ID = "6001";
export const OTHER_APPROVER_ID = "6002";

export const approverEntries = (
  bot: { name: string; platform: Platform },
  userIds: string[],
): Record<string, string> =>
  Object.fromEntries(
    userIds.map((userId) => [approverParameter(bot.name, bot.platform, userId), encodeEntry()]),
  );

export async function pendingAccessHarness(
  kind: "chat" | "user",
  options: Parameters<typeof accessHarness>[0] = {},
) {
  const h = await accessHarness(options);
  const { thread } = fakeThread();
  await h.requestAccess(kind, thread, fakeMessage({ userId: STRANGER_USER_ID, isMention: true }));
  return h;
}

export const commandFrom = (
  name: string,
  text: string,
  overrides: { userId?: string; isDM?: boolean } = {},
) => ({
  command: name,
  text,
  user: { userId: overrides.userId ?? ADMIN_ID },
  isDM: overrides.isDM ?? true,
});

export const REQUESTER_ID = "7001";
export const REQUESTER_THREAD_ID = `telegram:${REQUESTER_ID}`;

export async function approverHarness({
  standing = "approved",
  ...options
}: Parameters<typeof accessHarness>[0] & { standing?: "approved" | "blocked" | "stranger" } = {}) {
  const h = await accessHarness(options);
  const subjectName = { name: "Pat Example" };
  if (standing === "approved") {
    h.params.values[approvedParameter("garden", "telegram", "user", REQUESTER_ID)] =
      encodeEntry(subjectName);
  } else if (standing === "blocked") {
    h.params.values[approvedParameter("garden", "telegram", "user", REQUESTER_ID)] =
      encodeEntry(subjectName);
    h.params.values[blockedParameter("garden", "telegram", "user", REQUESTER_ID)] =
      encodeEntry(subjectName);
  }
  const resolveAccess = createAccessResolver(GARDEN_BOT, h.params, 0);
  const approverCommand = vi.fn(
    createApproverCommand({
      bot: GARDEN_BOT,
      params: h.params,
      store: h.store,
      resolveAccess,
      requestApprover: createApproverRequester({
        bot: GARDEN_BOT,
        params: h.params,
        store: h.store,
        channel: telegramAdminChannel,
        messenger: h.messenger,
        logger: h.logger,
      }),
      logger: h.logger,
    }),
  );
  const approverEntry = (userId = REQUESTER_ID) =>
    h.params.values[approverParameter("garden", "telegram", userId)];
  const approveRequest = () => h.decisions.fromReaction(h.reaction("👍"));
  const askToBeApprover = () =>
    approverCommand({
      sub: "request",
      userId: REQUESTER_ID,
      name: "Pat Example",
      isDM: true,
      threadId: REQUESTER_THREAD_ID,
    });
  const setApprovers = (userIds: string[]) => {
    for (const name of Object.keys(h.params.values)) {
      if (name.includes("/approvers/")) delete h.params.values[name];
    }
    Object.assign(h.params.values, approverEntries(GARDEN_BOT, userIds));
  };
  return {
    ...h,
    resolveAccess,
    approverCommand,
    approverEntry,
    approveRequest,
    askToBeApprover,
    setApprovers,
  };
}

export type ApproverHarness = Awaited<ReturnType<typeof approverHarness>>;

export interface ApproverAsk {
  userId?: string;
  isDM?: boolean;
  /** The Telegram user whose message the command replies to. */
  replyTo?: { id: number; isBot?: boolean; firstName?: string };
}

export const asAdmin = { userId: ADMIN_ID };

export const approverKeys = (h: Pick<ApproverHarness, "params">) =>
  Object.keys(h.params.values)
    .filter((name) => name.includes("/approvers/"))
    .sort();

/** What a route did with an `approver <sub>` message: what it posted, and whether it fell through. */
export interface ApproverRouteResult {
  posts: string[];
  fellThrough: boolean;
}

const fellThroughOf = async (h: ApproverHarness): Promise<boolean> =>
  (await h.approverCommand.mock.results.at(-1)?.value) === undefined;

/** The Telegram route: the `/approver <sub>` slash handler. */
export async function viaSlashCommand(
  h: ApproverHarness,
  sub: string,
  { userId = REQUESTER_ID, isDM = true, replyTo }: ApproverAsk = {},
): Promise<ApproverRouteResult> {
  const chat = { onReaction: vi.fn(), onSlashCommand: vi.fn(), processMessage: vi.fn() };
  registerAdminHandlers(chat, telegramAdminChannel, h.decisions, vi.fn(), h.approverCommand);
  const handler = chat.onSlashCommand.mock.calls.find(([names]) =>
    names.includes("/approver"),
  )?.[1];
  const post = vi.fn();
  await handler({
    command: "/approver",
    text: sub,
    user: { userId, fullName: "Pat Example" },
    adapter: { isDM: () => isDM, parseMessage: vi.fn(() => ({})) },
    raw: replyTo
      ? {
          reply_to_message: {
            from: { id: replyTo.id, is_bot: replyTo.isBot ?? false, first_name: replyTo.firstName },
          },
        }
      : {},
    channel: { id: REQUESTER_THREAD_ID, post },
  });
  return { posts: post.mock.calls.map(([text]) => text), fellThrough: await fellThroughOf(h) };
}

/** The Slack route: the `approver <sub>` word in a direct message. */
export async function viaDirectMessage(
  h: ApproverHarness,
  sub: string,
  { userId = REQUESTER_ID, isDM = true }: ApproverAsk = {},
): Promise<ApproverRouteResult> {
  const handle = createMessageHandler({
    bot: GARDEN_BOT,
    resolveAccess: h.resolveAccess,
    requestAccess: h.requestAccess,
    attachments: fakeAttachments(),
    approverCommand: h.approverCommand,
    resolveSettings: async () => ownershipSettings("all"),
    dispatcher: h.dispatcher,
    threadMeta: noThreadMeta(),
    searchTokens: noSearchTokens(),
    logger: h.logger,
  });
  const { thread, post } = fakeThread({ isDM, chatId: userId });
  const raw = { text: `approver ${sub}` };
  const text = raw.text.replace(/<@(\w+)(?:\|[^>]*)?>/g, "@name");
  await handle(thread, fakeMessage({ userId, text, raw, isMention: true }));
  return {
    posts: (post.mock.calls as unknown as [string][]).map(([text]) => text),
    fellThrough: await fellThroughOf(h),
  };
}

export const APPROVER_ROUTES = [
  ["the Telegram slash command", viaSlashCommand],
  ["the Slack direct-message word", viaDirectMessage],
] as const;

export const SLACK_ADMIN_ID = "U0ADMIN1";

/** The approver command of a Slack bot over its own store, wired like `approverHarness` for the routes. */
export async function slackApproverHarness({ approvers = [] }: { approvers?: string[] } = {}) {
  const h = await approverHarness();
  const params = fakeParameterStore({
    [adminParameter("slack")]: SLACK_ADMIN_ID,
    ...approverEntries(SLACK_BOT, approvers),
  });
  const resolveAccess = createAccessResolver(SLACK_BOT, params, 0);
  const approverCommand = vi.fn(
    createApproverCommand({
      bot: SLACK_BOT,
      params,
      store: h.store,
      resolveAccess,
      requestApprover: vi.fn(),
      logger: h.logger,
    }),
  );
  const approverEntry = (userId = REQUESTER_ID) =>
    params.values[approverParameter(SLACK_BOT.name, SLACK_BOT.platform, userId)];
  return { ...h, params, resolveAccess, approverCommand, approverEntry };
}
