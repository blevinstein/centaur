import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { type Adapter, Chat, type Logger, type StateAdapter } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import { createAccessDecisions } from "./access-decisions.js";
import { createAccessRequestStore } from "./access-request-store.js";
import { createAccessRequester, createApproverRequester } from "./access-requests.js";
import { ADMIN_CHANNELS } from "./admin-channel.js";
import { createAdminClaimer } from "./admin-claims.js";
import { registerAdminHandlers } from "./admin-handlers.js";
import { showApprovalState } from "./approval-reactions.js";
import { createApproverCommand } from "./approver-commands.js";
import type { AttachmentStore } from "./attachments.js";
import { DEFAULT_FAILURE_NOTICE_MINUTES, withFailureNotice } from "./dispatch-failure-notice.js";
import type { RepositoryDispatcher } from "./github.js";
import { DEFAULT_HISTORY_WINDOW, type HistoryWindow } from "./history-window.js";
import { createMessageHandler } from "./message-handler.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, readPlatformSettings } from "./registry.js";
import { createSelfIdentityLookup, withSelfIdentity } from "./self-identity.js";
import type { TelegramApi } from "./telegram.js";
import { createThreadMeta } from "./thread-meta.js";

const ADAPTER_FACTORIES: Record<Platform, (bot: Bot, logger: Logger) => Adapter> = {
  telegram: (bot, logger) =>
    createTelegramAdapter({
      botToken: bot.token,
      secretToken: bot.webhookSecret,
      mode: "webhook",
      logger,
    }),
  slack: (bot, logger) =>
    createSlackAdapter({ botToken: bot.token, signingSecret: bot.webhookSecret, logger }),
};

export type BotChat = Chat<Record<string, Adapter>, ThreadMetadata>;

export interface BotChatBaseDeps {
  bot: Bot;
  botState: StateAdapter;
  logger: Logger;
  history?: HistoryWindow | undefined;
}

export interface BotChatDeps extends BotChatBaseDeps {
  /** Minimum time between dispatch failure notices; 0 sends none. */
  failureNoticeIntervalMs?: number | undefined;
  params: ParameterStore;
  registryState: StateAdapter;
  attachments: AttachmentStore;
  dispatcher: RepositoryDispatcher;
  /** Reads the bot's own display name on Telegram; without it the Telegram identity is the user name. */
  telegram?: Pick<TelegramApi, "getMe"> | undefined;
}

export const createChat = ({
  bot,
  botState,
  logger,
  history = DEFAULT_HISTORY_WINDOW,
}: BotChatBaseDeps): BotChat =>
  new Chat<Record<string, Adapter>, ThreadMetadata>({
    userName: bot.name,
    adapters: { [bot.platform]: ADAPTER_FACTORIES[bot.platform](bot, logger.child(bot.platform)) },
    state: botState,
    concurrency: "concurrent",
    history: { thread: history },
    logger,
  });

export function createBotChat({
  bot,
  params,
  registryState,
  botState,
  attachments,
  dispatcher: rawDispatcher,
  telegram,
  failureNoticeIntervalMs = DEFAULT_FAILURE_NOTICE_MINUTES * 60_000,
  logger,
  history,
}: BotChatDeps) {
  const chat = createChat({ bot, botState, logger, history });
  const resolveAccess = createAccessResolver(bot, params);
  const channel = ADMIN_CHANNELS[bot.platform];
  const store = createAccessRequestStore(botState);
  const claimAdmin = createAdminClaimer({
    bot,
    params,
    state: botState,
    invalidateAccess: resolveAccess.invalidate,
    logger,
  });
  const requesterDeps = { bot, params, store, channel, messenger: chat, logger };
  const lookupIdentity = createSelfIdentityLookup({ telegram, logger });
  const identifiedDispatcher = withSelfIdentity(rawDispatcher, () =>
    lookupIdentity(bot, chat.getAdapter(bot.platform)),
  );
  const dispatcher = withFailureNotice(identifiedDispatcher, {
    bot,
    intervalMs: failureNoticeIntervalMs,
    params,
    state: botState,
    channel,
    messenger: chat,
    logger,
  });
  const approverCommand = createApproverCommand({
    bot,
    params,
    store,
    resolveAccess,
    requestApprover: createApproverRequester(requesterDeps),
    logger,
  });
  const handle = createMessageHandler({
    bot,
    resolveAccess,
    requestAccess: createAccessRequester(requesterDeps),
    attachments,
    claimAdmin: channel.commands ? undefined : claimAdmin,
    approverCommand: channel.commands ? undefined : approverCommand,
    resolveSettings: () => readPlatformSettings(registryState, bot, logger),
    dispatcher,
    threadMeta: createThreadMeta(botState),
    logger,
  });
  registerAdminHandlers(
    chat,
    channel,
    createAccessDecisions({
      bot,
      params,
      store,
      channel,
      invalidateAccess: resolveAccess.invalidate,
      postToThread: (threadId, text) => chat.thread(threadId).post(text),
      showApproval: (threadId, messageId, state) =>
        showApprovalState({
          adapter: chat.thread(threadId).adapter,
          bot,
          threadId,
          messageId,
          state,
          logger,
        }),
      dispatcher,
      logger,
    }),
    claimAdmin,
    approverCommand,
  );
  chat.onDirectMessage(handle);
  chat.onNewMention(handle);
  chat.onSubscribedMessage(handle);
  chat.onNewMessage(handle);
  return chat;
}
