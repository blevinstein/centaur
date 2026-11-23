import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { createAccessDecisions } from "../../src/lambda/access-decisions.js";
import {
  type AccessRequestLimits,
  createAccessRequestStore,
} from "../../src/lambda/access-request-store.js";
import { createAccessRequester } from "../../src/lambda/access-requests.js";
import { telegramAdminChannel } from "../../src/lambda/admin-channel.js";
import { encodeClaim } from "../../src/lambda/admin-claim-record.js";
import { createAdminClaimer } from "../../src/lambda/admin-claims.js";
import {
  fakeLogger,
  fakeParameterStore,
  GARDEN_BOT,
  PARAMETERS,
  SLACK_BOT,
} from "./receiver-fixtures.js";

const { "/centaur/chats/telegram/household": _household, ...ACCESS_PARAMETERS } = PARAMETERS;

export const ADMIN_ID = "5001";
export const ADMIN_DM_MESSAGE_ID = "telegram:5001:900";
export const ADMIN_PARAMETER = "/centaur/admin/telegram";

export async function accessHarness({
  admin = ADMIN_ID,
  limits,
  dmFails = false,
}: {
  admin?: string | null;
  limits?: Partial<AccessRequestLimits>;
  dmFails?: boolean;
} = {}) {
  const state = createMemoryState();
  await state.connect();
  const params = fakeParameterStore({
    ...ACCESS_PARAMETERS,
    ...(admin ? { [ADMIN_PARAMETER]: admin } : {}),
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
  const invalidateAccess = vi.fn();
  const postToThread = vi.fn(async (_threadId: string, _text: string) => ({}));
  const decisions = createAccessDecisions({
    bot: GARDEN_BOT,
    params,
    store,
    channel: telegramAdminChannel,
    invalidateAccess,
    postToThread,
    logger,
  });
  const adminText = () => adminPost.mock.calls[0]?.[0].raw ?? "";
  const requestId = () => /Access request (\w+)/.exec(adminText())?.[1] as string;
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
    store,
    params,
    messenger,
    adminPost,
    adminText,
    requestId,
    logger,
    requestAccess,
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
