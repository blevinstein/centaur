import { createSlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { type Adapter, Chat, type Logger, type StateAdapter } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import type { RepositoryDispatcher } from "./github.js";
import { createMessageHandler } from "./message-handler.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

const ADAPTER_FACTORIES: Record<Platform, (bot: Bot) => Adapter> = {
  telegram: (bot) =>
    createTelegramAdapter({ botToken: bot.token, secretToken: bot.webhookSecret, mode: "webhook" }),
  slack: (bot) => createSlackAdapter({ botToken: bot.token, signingSecret: bot.webhookSecret }),
};

export interface BotChatDeps {
  bot: Bot;
  params: ParameterStore;
  registryState: StateAdapter;
  botState: StateAdapter;
  dispatcher: RepositoryDispatcher;
  logger: Logger;
}

export function createBotChat({
  bot,
  params,
  registryState,
  botState,
  dispatcher,
  logger,
}: BotChatDeps) {
  const chat = new Chat<Record<string, Adapter>, ThreadMetadata>({
    userName: bot.name,
    adapters: { [bot.platform]: ADAPTER_FACTORIES[bot.platform](bot) },
    state: botState,
    concurrency: "concurrent",
    logger,
  });
  const handle = createMessageHandler({
    bot,
    resolveAccess: createAccessResolver(bot, params, registryState),
    dispatcher,
    logger,
  });
  chat.onDirectMessage(handle);
  chat.onNewMention(handle);
  chat.onSubscribedMessage(handle);
  chat.onNewMessage(handle);
  return chat;
}
