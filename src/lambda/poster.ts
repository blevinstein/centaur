import { type Adapter, type Chat, emoji, type Logger, type StateAdapter } from "chat";
import { z } from "zod";
import { alias, type Platform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import type { OidcVerifier } from "./oidc.js";
import { BOT_CREATED_STATE, type ThreadMetadata } from "./ownership.js";
import { chatParameter, type ParameterStore } from "./parameters.js";
import { createRegister } from "./register.js";
import { type Bot, botStatePrefix, loadBot } from "./registry.js";
import type { TelegramApi } from "./telegram.js";

const TOPIC_NAME_MAX = 128;
export const UNREACT_MAX_MESSAGES = 50;

const text = z.string().min(1);
const threadId = z.string().min(1);

export const posterRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("post"), bot: alias, threadId, text }),
  z
    .strictObject({
      operation: z.literal("start-thread"),
      bot: alias,
      text,
      title: z.string().min(1).max(TOPIC_NAME_MAX).optional(),
      destination: alias.optional(),
      fromThreadId: threadId.optional(),
    })
    .refine(
      (request) => (request.destination === undefined) !== (request.fromThreadId === undefined),
      {
        message: "start-thread needs exactly one of destination and fromThreadId",
      },
    ),
  z.strictObject({ operation: z.literal("read"), bot: alias, threadId }),
  z.strictObject({
    operation: z.literal("unreact"),
    bot: alias,
    threadId,
    messageIds: z.array(z.string().min(1)).min(1).max(UNREACT_MAX_MESSAGES),
  }),
  z.strictObject({ operation: z.literal("register"), token: z.string().min(1), config: text }),
]);

export type PosterRequest = z.input<typeof posterRequestSchema>;

export type PosterChat = Pick<
  Chat<Record<string, Adapter>, ThreadMetadata>,
  "initialize" | "thread" | "channel"
>;

export interface PosterDeps {
  params: ParameterStore;
  stateFor: (keyPrefix: string) => StateAdapter;
  chatFor: (bot: Bot, botState: StateAdapter) => PosterChat;
  telegram: TelegramApi;
  oidc: OidcVerifier;
  functionUrl: string;
  logger: Pick<Logger, "warn">;
}

interface OpenedThread {
  threadId: string;
  posted: boolean;
}

type ThreadOpener = (
  bot: Bot,
  chat: PosterChat,
  destination: { chatId: string; text: string; title: string },
  telegram: TelegramApi,
) => Promise<OpenedThread>;

const THREAD_OPENERS: Record<Platform, ThreadOpener> = {
  telegram: async (bot, _chat, { chatId, title }, telegram) => ({
    threadId: `telegram:${chatId}:${await telegram.createForumTopic(bot.token, chatId, title)}`,
    posted: false,
  }),
  slack: async (_bot, chat, { chatId, text }) => ({
    threadId: (await chat.channel(`slack:${chatId}`).post(text)).threadId,
    posted: true,
  }),
};

const firstLine = (value: string) => value.trim().split("\n")[0]?.slice(0, TOPIC_NAME_MAX) ?? "";

export function createPoster(deps: PosterDeps) {
  const { params, stateFor, chatFor, telegram, logger } = deps;
  const register = createRegister({
    params,
    registryState: stateFor(""),
    oidc: deps.oidc,
    telegram,
    functionUrl: deps.functionUrl,
  });

  const openChat = async (botName: string) => {
    const bot = await loadBot(params, botName);
    if (!bot) throw new Error(`unknown or unbound bot "${botName}"`);
    const chat = chatFor(bot, stateFor(botStatePrefix(bot.name)));
    await chat.initialize();
    return { bot, chat };
  };

  const startChatId = async (
    bot: Bot,
    chat: PosterChat,
    target: { destination?: string | undefined; fromThreadId?: string | undefined },
  ) => {
    const { chatIds, blockedChatIds } = await createAccessResolver(bot, params)();
    const approve = (chatId: string) => `centaur access approve ${bot.name} chat ${chatId}`;
    if (target.destination !== undefined) {
      const chatId = await params.get(chatParameter(target.destination));
      if (!chatId) {
        throw new Error(
          `unknown chat alias "${target.destination}"; approve the chat under that name with \`centaur access approve ${bot.name} chat <id> --alias ${target.destination}\``,
        );
      }
      if (blockedChatIds.has(chatId)) {
        throw new Error(`chat "${target.destination}" is blocked for bot "${bot.name}"`);
      }
      if (!chatIds.has(chatId)) {
        throw new Error(
          `chat "${target.destination}" is not approved for bot "${bot.name}"; the maintainer must approve it with \`${approve(chatId)}\``,
        );
      }
      return chatId;
    }
    const origin = chat.thread(target.fromThreadId as string);
    const chatId = origin.channelId.slice(bot.platform.length + 1);
    if (!origin.isDM && !chatIds.has(chatId)) {
      throw new Error(
        `chat ${chatId} is not approved for bot "${bot.name}"; the maintainer must approve it with \`${approve(chatId)}\``,
      );
    }
    return chatId;
  };

  return async (rawRequest: unknown) => {
    const request = posterRequestSchema.parse(rawRequest);
    switch (request.operation) {
      case "register":
        return register(request);
      case "post": {
        const { chat } = await openChat(request.bot);
        const sent = await chat.thread(request.threadId).post(request.text);
        return { messageId: sent.id };
      }
      case "start-thread": {
        const { bot, chat } = await openChat(request.bot);
        const opened = await THREAD_OPENERS[bot.platform](
          bot,
          chat,
          {
            chatId: await startChatId(bot, chat, request),
            text: request.text,
            title: request.title ?? firstLine(request.text),
          },
          telegram,
        );
        const thread = chat.thread(opened.threadId);
        await thread.setState(BOT_CREATED_STATE);
        if (!opened.posted) await thread.post(request.text);
        return { threadId: opened.threadId };
      }
      case "read": {
        const { chat } = await openChat(request.bot);
        const messages = [];
        for await (const message of chat.thread(request.threadId).allMessages) {
          messages.push({
            id: message.id,
            userId: message.author.userId,
            userName: message.author.userName,
            fromBot: message.author.isMe,
            text: message.text,
            sentAt: message.metadata.dateSent.toISOString(),
          });
        }
        return { messages };
      }
      case "unreact": {
        const { bot, chat } = await openChat(request.bot);
        const thread = chat.thread(request.threadId);
        const results = [];
        for (const messageId of request.messageIds) {
          try {
            await thread.adapter.removeReaction(thread.id, messageId, emoji.eyes);
            results.push({ messageId, removed: true });
          } catch (error) {
            logger.warn("failed to remove reaction", {
              bot: bot.name,
              threadId: request.threadId,
              messageId,
              error,
            });
            results.push({ messageId, removed: false });
          }
        }
        return { results };
      }
    }
  };
}
