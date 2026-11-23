import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { type Adapter, Chat, type Logger, type StateAdapter } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import { createAccessDecisions } from "./access-decisions.js";
import { createAccessRequestStore } from "./access-request-store.js";
import { createAccessRequester } from "./access-requests.js";
import { ADMIN_CHANNELS } from "./admin-channel.js";
import { createAdminClaimer } from "./admin-claims.js";
import { registerAdminHandlers } from "./admin-handlers.js";
import type { AttachmentStore } from "./attachments.js";
import type { RepositoryDispatcher } from "./github.js";
import { DEFAULT_HISTORY_WINDOW, type HistoryWindow } from "./history-window.js";
import { createMessageHandler } from "./message-handler.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, readPlatformSettings } from "./registry.js";
import { createThreadMeta } from "./thread-meta.js";

const ADAPTER_FACTORIES: Record<Platform, (bot: Bot) => Adapter> = {
  telegram: (bot) =>
    createTelegramAdapter({ botToken: bot.token, secretToken: bot.webhookSecret, mode: "webhook" }),
  slack: (bot) => createSlackAdapter({ botToken: bot.token, signingSecret: bot.webhookSecret }),
};

export type BotChat = Chat<Record<string, Adapter>, ThreadMetadata>;

export interface BotChatBaseDeps {
  bot: Bot;
  botState: StateAdapter;
  logger: Logger;
  history?: HistoryWindow | undefined;
}

export interface BotChatDeps extends BotChatBaseDeps {
  params: ParameterStore;
  registryState: StateAdapter;
  attachments: AttachmentStore;
  dispatcher: RepositoryDispatcher;
}

export const createChat = ({
  bot,
  botState,
  logger,
  history = DEFAULT_HISTORY_WINDOW,
}: BotChatBaseDeps): BotChat =>
  new Chat<Record<string, Adapter>, ThreadMetadata>({
    userName: bot.name,
    adapters: { [bot.platform]: ADAPTER_FACTORIES[bot.platform](bot) },
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
  dispatcher,
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
  const handle = createMessageHandler({
    bot,
    resolveAccess,
    requestAccess: createAccessRequester({
      bot,
      params,
      store,
      channel,
      messenger: chat,
      logger,
    }),
    attachments,
    claimAdmin: channel.commands ? undefined : claimAdmin,
    resolveRespondTo: async () =>
      (await readPlatformSettings(registryState, bot, logger))?.respond_to,
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
      logger,
    }),
    claimAdmin,
  );
  chat.onDirectMessage(handle);
  chat.onNewMention(handle);
  chat.onSubscribedMessage(handle);
  chat.onNewMessage(handle);
  return chat;
}
