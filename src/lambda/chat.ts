import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { type Adapter, Chat, type Logger, type StateAdapter } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import type { RepositoryDispatcher } from "./github.js";
import { createMessageHandler } from "./message-handler.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, readRespondTo } from "./registry.js";

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
}

export interface BotChatDeps extends BotChatBaseDeps {
  params: ParameterStore;
  registryState: StateAdapter;
  dispatcher: RepositoryDispatcher;
}

export const createChat = ({ bot, botState, logger }: BotChatBaseDeps): BotChat =>
  new Chat<Record<string, Adapter>, ThreadMetadata>({
    userName: bot.name,
    adapters: { [bot.platform]: ADAPTER_FACTORIES[bot.platform](bot) },
    state: botState,
    concurrency: "concurrent",
    logger,
  });

export function createBotChat({
  bot,
  params,
  registryState,
  botState,
  dispatcher,
  logger,
}: BotChatDeps) {
  const chat = createChat({ bot, botState, logger });
  const handle = createMessageHandler({
    bot,
    resolveAccess: createAccessResolver(bot, params, registryState),
    resolveRespondTo: () => readRespondTo(registryState, bot.name),
    dispatcher,
    logger,
  });
  chat.onDirectMessage(handle);
  chat.onNewMention(handle);
  chat.onSubscribedMessage(handle);
  chat.onNewMessage(handle);
  return chat;
}
