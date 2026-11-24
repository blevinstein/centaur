import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import type { Platform } from "../../src/config/index.js";
import { createAccessDecisions } from "../../src/lambda/access-decisions.js";
import { encodeEntry } from "../../src/lambda/access-entries.js";
import {
  type AccessRequestLimits,
  createAccessRequestStore,
} from "../../src/lambda/access-request-store.js";
import {
  createAccessRequester,
  createMcpApprovalRequester,
  type McpApprovalInput,
} from "../../src/lambda/access-requests.js";
import { telegramAdminChannel } from "../../src/lambda/admin-channel.js";
import { encodeClaim } from "../../src/lambda/admin-claim-record.js";
import { createAdminClaimer } from "../../src/lambda/admin-claims.js";
import { approverParameter } from "../../src/lambda/connection-paths.js";
import {
  fakeDispatcher,
  fakeLogger,
  fakeMessage,
  fakeParameterStore,
  fakeThread,
  GARDEN_BOT,
  PARAMETERS,
  SLACK_BOT,
  STRANGER_USER_ID,
} from "./receiver-fixtures.js";

const { "/centaur/chats/telegram/household": _household, ...ACCESS_PARAMETERS } = PARAMETERS;

export const ADMIN_ID = "5001";
export const ADMIN_DM_MESSAGE_ID = "telegram:5001:900";
export const ADMIN_PARAMETER = "/centaur/admin/telegram";

export async function accessHarness({
  admin = ADMIN_ID,
  limits,
  dmFails = false,
  approvers = [],
}: {
  admin?: string | null;
  limits?: Partial<AccessRequestLimits>;
  dmFails?: boolean;
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
  const adminPost = vi.fn(async (_message: { raw: string }) => ({ id: ADMIN_DM_MESSAGE_ID }));
  const messenger = {
    openDM: vi.fn(async (_userId: string) => {
      if (dmFails) throw new Error("chat not found");
      return { post: adminPost };
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
  const invalidateAccess = vi.fn();
  const postToThread = vi.fn(async (_threadId: string, _text: string) => ({}));
  const decisions = createAccessDecisions({
    bot: GARDEN_BOT,
    params,
    store,
    channel: telegramAdminChannel,
    invalidateAccess,
    postToThread,
    dispatcher,
    logger,
  });
  const adminText = (index = 0) => adminPost.mock.calls[index]?.[0].raw ?? "";
  const requestId = (index = 0) => /Access request (\w+)/.exec(adminText(index))?.[1] as string;
  const reaction = (
    rawEmoji: string,
    overrides: { userId?: string; messageId?: string; added?: boolean; isDM?: boolean } = {},
  ) => ({
    added: overrides.added ?? true,
    rawEmoji,
    messageId: overrides.messageId ?? ADMIN_DM_MESSAGE_ID,
    user: { userId: overrides.userId ?? admin ?? ADMIN_ID },
    thread: { isDM: overrides.isDM ?? true },
  });
  return {
    state,
    store,
    params,
    messenger,
    adminPost,
    adminText,
    requestId,
    logger,
    requestAccess,
    requestMcp,
    dispatcher,
    decisions,
    invalidateAccess,
    postToThread,
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
