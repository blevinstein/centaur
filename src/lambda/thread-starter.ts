import type { StateAdapter } from "chat";
import { type Platform, type ThreadMode, threadPlatform } from "../config/index.js";
import { createAccessResolver } from "./access.js";
import {
  createDestinationOnFirstUse,
  type Destination,
  resolveDestination,
  saveDestination,
} from "./destinations.js";
import { BOT_CREATED_STATE } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import type { PosterChat } from "./poster.js";
import type { Bot } from "./registry.js";
import type { TelegramApi } from "./telegram.js";
import { firstLine } from "./text.js";
import type { ThreadMetaStore } from "./thread-meta.js";

export const TOPIC_NAME_MAX = 128;
const LOCK_TTL_MS = 30_000;
const TOPIC_GONE = /thread not found/i;
const TOPIC_CLOSED = /topic[_ ]closed/i;
const NOT_A_FORUM = /not a forum/i;

export interface StartThreadRequest {
  bot: string;
  text: string;
  title?: string | undefined;
  destination?: string | undefined;
  platform?: Platform | undefined;
  fromThreadId?: string | undefined;
  context?: Destination["context"];
  thread?: ThreadMode | undefined;
}

export interface ResolveDestinationRequest {
  bot: string;
  name: string;
  platform?: Platform | undefined;
  thread?: ThreadMode | undefined;
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

const PERSISTENT_PLATFORMS: Platform[] = ["telegram"];

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const topicOf = (threadId: string) => Number(threadId.slice(threadId.lastIndexOf(":") + 1));

export interface ThreadStarterDeps {
  params: ParameterStore;
  telegram: TelegramApi;
  loadBot: (botName: string, platform?: Platform) => Promise<Bot>;
  openChat: (
    botName: string,
    platform?: Platform,
  ) => Promise<{ bot: Bot; chat: PosterChat; threadMeta: ThreadMetaStore; state: StateAdapter }>;
  requireApprovedChat: (bot: Bot, chatId: string, name?: string) => Promise<unknown>;
}

export function createThreadStarter({
  params,
  telegram,
  loadBot,
  openChat,
  requireApprovedChat,
}: ThreadStarterDeps) {
  const locate = async (bot: Bot, name: string): Promise<Destination> => {
    const found = await resolveDestination(params, bot, name);
    if (found) {
      await requireApprovedChat(bot, found.chatId, `"${name}"`);
      return found;
    }
    const access = await createAccessResolver(bot, params)();
    return createDestinationOnFirstUse(params, bot, name, access.chatIds);
  };

  const start = async (request: StartThreadRequest) => {
    const { bot, chat, threadMeta, state } = await openChat(
      request.bot,
      request.fromThreadId === undefined ? request.platform : threadPlatform(request.fromThreadId),
    );
    const title = request.title ?? firstLine(request.text, TOPIC_NAME_MAX);

    const deliver = async (opened: OpenedThread, destination?: string) => {
      const thread = chat.thread(opened.threadId);
      await thread.setState(BOT_CREATED_STATE);
      await threadMeta.write(opened.threadId, {
        setBy: "start-thread",
        context: request.context,
        destination,
      });
      if (!opened.posted) await thread.post(request.text);
      return opened.threadId;
    };

    const open = async (chatId: string, label: string, destination?: string) => {
      try {
        return await deliver(
          await THREAD_OPENERS[bot.platform](
            bot,
            chat,
            { chatId, text: request.text, title },
            telegram,
          ),
          destination,
        );
      } catch (error) {
        if (NOT_A_FORUM.test(reasonOf(error))) {
          throw new Error(`${label} is a chat without forum topics, so it cannot hold a thread`);
        }
        throw error;
      }
    };

    /** Posts into the bound topic; undefined when it is gone (or closed and cannot be reopened). */
    const redeliver = async (name: string, threadId: string, chatId: string) => {
      const post = () => deliver({ threadId, posted: false }, name);
      try {
        return await post();
      } catch (error) {
        if (TOPIC_CLOSED.test(reasonOf(error))) {
          try {
            await telegram.reopenForumTopic(bot.token, chatId, topicOf(threadId));
            return await post();
          } catch {}
        } else if (!TOPIC_GONE.test(reasonOf(error))) {
          throw error;
        }
        return undefined;
      }
    };

    if (request.destination === undefined) {
      const origin = chat.thread(request.fromThreadId as string);
      const chatId = origin.channelId.slice(bot.platform.length + 1);
      if (!origin.isDM) await requireApprovedChat(bot, chatId);
      return { threadId: await open(chatId, "the chat of this thread") };
    }

    const name = request.destination;
    const label = `destination "${name}"`;

    if (request.thread !== "persistent") {
      const { chatId } = await locate(bot, name);
      return { threadId: await open(chatId, label) };
    }

    if (!PERSISTENT_PLATFORMS.includes(bot.platform)) {
      throw new Error(`a persistent thread is not supported on ${bot.platform} yet`);
    }
    const lock = await state.acquireLock(`destination:${bot.platform}:${name}`, LOCK_TTL_MS);
    if (!lock) throw new Error(`${label} is being set up by another run; try again shortly`);
    try {
      const record = await locate(bot, name);
      const reused = record.threadId
        ? await redeliver(name, record.threadId, record.chatId)
        : undefined;
      const threadId = reused ?? (await open(record.chatId, label, name));
      if (threadId !== record.threadId || record.context !== request.context) {
        await saveDestination(params, bot.platform, name, {
          ...record,
          threadId,
          bot: bot.name,
          context: request.context,
        });
      }
      return { threadId };
    } finally {
      await state.releaseLock(lock);
    }
  };

  const resolve = async (request: ResolveDestinationRequest) => {
    const bot = await loadBot(request.bot, request.platform);
    const found = await resolveDestination(params, bot, request.name);
    if (!found) return { found: false as const };
    await requireApprovedChat(bot, found.chatId, `"${request.name}"`);
    return {
      chatId: found.chatId,
      ...(request.thread === "persistent" && found.threadId ? { threadId: found.threadId } : {}),
    };
  };

  return { start, resolve };
}
