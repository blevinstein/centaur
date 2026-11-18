import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { createAccessDecisions } from "../../src/lambda/access-decisions.js";
import {
  type AccessRequestLimits,
  createAccessRequestStore,
} from "../../src/lambda/access-request-store.js";
import { createAccessRequester } from "../../src/lambda/access-requests.js";
import { telegramAdminChannel } from "../../src/lambda/admin-channel.js";
import { fakeLogger, fakeParameterStore, GARDEN_BOT, PARAMETERS } from "./receiver-fixtures.js";

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
    ...PARAMETERS,
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
