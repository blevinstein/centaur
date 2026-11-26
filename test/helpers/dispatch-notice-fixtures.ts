import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { adminParameter } from "../../src/lambda/access-entries.js";
import { ADMIN_CHANNELS } from "../../src/lambda/admin-channel.js";
import {
  DEFAULT_FAILURE_NOTICE_MINUTES,
  withFailureNotice,
} from "../../src/lambda/dispatch-failure-notice.js";
import { DispatchError } from "../../src/lambda/github.js";
import { createMessageHandler } from "../../src/lambda/message-handler.js";
import { ownershipSettings } from "./ownership-fixtures.js";
import {
  accessFor,
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeMessage,
  fakeParameterStore,
  fakeThread,
  GARDEN_BOT,
  noSearchTokens,
  PARAMETERS,
} from "./receiver-fixtures.js";
import { noThreadMeta } from "./thread-meta-fixtures.js";

export const MINUTE_MS = 60_000;
export const NOTICE_ADMIN_ID = "5001";
export const SECRET_TEXT = "tomato-secret-text";
export const SECRET_USER_ID = "1001";

export async function noticeHarness({
  bot = GARDEN_BOT,
  admin = NOTICE_ADMIN_ID,
  dmFails = false,
  intervalMs = DEFAULT_FAILURE_NOTICE_MINUTES * MINUTE_MS,
}: {
  bot?: typeof GARDEN_BOT;
  admin?: string | null;
  dmFails?: boolean;
  intervalMs?: number;
} = {}) {
  const state = createMemoryState();
  await state.connect();
  const params = fakeParameterStore({
    ...PARAMETERS,
    ...(admin ? { [adminParameter(bot.platform)]: admin } : {}),
  });
  const post = vi.fn(async (_message: { raw: string }) => ({ id: "dm-1" }));
  const messenger = {
    openDM: vi.fn(async (userId: string) => {
      if (dmFails) throw new Error("chat not found");
      return { channelId: `${bot.platform}:${userId}`, post };
    }),
  };
  const logger = fakeLogger();
  const rawDispatcher = fakeDispatcher();
  const dispatcher = withFailureNotice(rawDispatcher, {
    bot,
    intervalMs,
    params,
    state,
    channel: ADMIN_CHANNELS[bot.platform],
    messenger,
    logger,
  });
  const failWith = (status?: number) =>
    rawDispatcher.dispatch.mockRejectedValue(
      status === undefined ? new Error("network down") : new DispatchError(bot.repo, status),
    );
  const dispatch = () => dispatcher.dispatch(bot.repo, "centaur-message", { bot: bot.name });
  const noticeText = (index = 0) => post.mock.calls[index]?.[0].raw ?? "";
  const handleMessage = () =>
    createMessageHandler({
      bot,
      resolveAccess: accessFor(),
      requestAccess: vi.fn(async () => false),
      attachments: fakeAttachments(),
      resolveSettings: async () => ownershipSettings(),
      dispatcher,
      threadMeta: noThreadMeta(),
      searchTokens: noSearchTokens(),
      logger,
    })(
      fakeThread().thread,
      fakeMessage({ isMention: true, text: SECRET_TEXT, userId: SECRET_USER_ID }),
    );
  return {
    state,
    params,
    messenger,
    post,
    logger,
    rawDispatcher,
    failWith,
    dispatch,
    noticeText,
    handleMessage,
  };
}
