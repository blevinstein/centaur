import type { Logger, Message } from "chat";
import { z } from "zod";
import { alias, type Platform } from "../config/index.js";
import type { Access } from "./access.js";
import type { OidcVerifier } from "./oidc.js";
import type { ParameterStore } from "./parameters.js";
import type { PosterChat } from "./poster.js";
import { type Bot, requireBound } from "./registry.js";
import { clip, firstLine } from "./text.js";

export const LIST_THREADS_DEFAULT = 20;
export const LIST_THREADS_MAX = 50;
export const READ_CHANNEL_DEFAULT = 50;
export const READ_CHANNEL_MAX = 200;
export const MESSAGE_TEXT_MAX = 4000;
export const SNIPPET_MAX = 200;
export const TITLE_MAX = 100;
export const PARTICIPANTS_MAX = 10;
export const STORED_HISTORY_SCAN_MAX = 2000;

const nonEmpty = z.string().min(1);
const count = (max: number) => z.number().int().positive().max(max);

const target = {
  token: nonEmpty,
  bot: alias,
  chatId: nonEmpty,
  /** The thread the turn was dispatched for; the poster derives the one chat the turn may read from it. */
  threadId: nonEmpty,
  includeBots: z.boolean().optional(),
};

export const listThreadsRequestSchema = z.strictObject({
  operation: z.literal("list-threads"),
  ...target,
  limit: count(LIST_THREADS_MAX).optional(),
});

export const readChannelRequestSchema = z.strictObject({
  operation: z.literal("read-channel"),
  ...target,
  limit: count(READ_CHANNEL_MAX).optional(),
  /** Only messages sent before this instant (ISO 8601), for paging backwards. */
  before: z.iso.datetime().optional(),
});

export const threadSummarySchema = z.object({
  threadId: z.string(),
  title: z.string(),
  lastActivity: z.string(),
  messageCount: z.number().int(),
  participants: z.array(z.string()),
  snippet: z.string(),
});

export const channelMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  userId: z.string(),
  userName: z.string(),
  fromBot: z.boolean(),
  text: z.string(),
  attachments: z.array(z.string()),
  sentAt: z.string(),
});

export const listThreadsResultSchema = z.object({ threads: z.array(threadSummarySchema) });
export const readChannelResultSchema = z.object({ messages: z.array(channelMessageSchema) });

export type ListThreadsRequest = z.input<typeof listThreadsRequestSchema>;
export type ReadChannelRequest = z.input<typeof readChannelRequestSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
export type ListThreadsResult = z.infer<typeof listThreadsResultSchema>;
export type ReadChannelResult = z.infer<typeof readChannelResultSchema>;

type Visible = (message: Message) => boolean;

interface ChannelQuery {
  chat: PosterChat;
  channelId: string;
  visible: Visible;
  limit: number;
}

interface ChannelReader {
  threads(query: ChannelQuery): Promise<ThreadSummary[]>;
  messages(query: ChannelQuery & { before?: Date | undefined }): Promise<Message[]>;
}

/** Messages from the bot itself and enrolled users; other bots only when the caller opts in. */
const visibleTo =
  (access: Access, includeBots: boolean): Visible =>
  ({ author }) => {
    if (author.isMe) return true;
    if (author.isBot === true) return includeBots;
    return access.userIds.has(author.userId);
  };

const toChannelMessage = (message: Message): ChannelMessage => ({
  id: message.id,
  threadId: message.threadId,
  userId: message.author.userId,
  userName: message.author.userName,
  fromBot: message.author.isMe,
  text: clip(message.text, MESSAGE_TEXT_MAX),
  attachments: [],
  sentAt: message.metadata.dateSent.toISOString(),
});

const summarize = (
  summary: Omit<ThreadSummary, "title" | "snippet"> & { first: string; last: string },
) => ({
  threadId: summary.threadId,
  title: firstLine(summary.first, TITLE_MAX),
  lastActivity: summary.lastActivity,
  messageCount: summary.messageCount,
  participants: summary.participants.slice(0, PARTICIPANTS_MAX),
  snippet: clip(summary.last, SNIPPET_MAX),
});

/** The receiver's stored history of a chat, newest first, bounded so a long-lived chat stays cheap. */
async function* storedHistory({ chat, channelId }: ChannelQuery) {
  let scanned = 0;
  for await (const message of chat.channel(channelId).messages) {
    if (++scanned > STORED_HISTORY_SCAN_MAX) return;
    yield message;
  }
}

const slackCursor = (before: Date) => (before.getTime() / 1000).toFixed(6);

const READERS: Record<Platform, ChannelReader> = {
  telegram: {
    async threads(query) {
      const groups = new Map<
        string,
        {
          first: string;
          last: string;
          lastActivity: string;
          participants: Set<string>;
          count: number;
        }
      >();
      for await (const message of storedHistory(query)) {
        if (!query.visible(message)) continue;
        const group = groups.get(message.threadId) ?? {
          first: "",
          last: message.text,
          lastActivity: message.metadata.dateSent.toISOString(),
          participants: new Set<string>(),
          count: 0,
        };
        group.first = message.text;
        group.participants.add(message.author.userName);
        group.count += 1;
        groups.set(message.threadId, group);
      }
      return [...groups].slice(0, query.limit).map(([threadId, group]) =>
        summarize({
          threadId,
          first: group.first,
          last: group.last,
          lastActivity: group.lastActivity,
          messageCount: group.count,
          participants: [...group.participants],
        }),
      );
    },
    async messages(query) {
      const found: Message[] = [];
      for await (const message of storedHistory(query)) {
        if (query.before && message.metadata.dateSent >= query.before) continue;
        if (!query.visible(message)) continue;
        found.push(message);
        if (found.length >= query.limit) break;
      }
      return found;
    },
  },
  slack: {
    async threads({ chat, channelId, visible, limit }) {
      const { adapter } = chat.channel(channelId);
      if (!adapter.listThreads) throw new Error(`${adapter.name} cannot list threads`);
      const { threads } = await adapter.listThreads(channelId, { limit });
      return threads
        .filter(({ rootMessage }) => visible(rootMessage))
        .map(({ id, rootMessage, replyCount, lastReplyAt }) =>
          summarize({
            threadId: id,
            first: rootMessage.text,
            last: rootMessage.text,
            lastActivity: (lastReplyAt ?? rootMessage.metadata.dateSent).toISOString(),
            messageCount: (replyCount ?? 0) + 1,
            participants: [rootMessage.author.userName],
          }),
        );
    },
    async messages({ chat, channelId, visible, limit, before }) {
      const { adapter } = chat.channel(channelId);
      if (!adapter.fetchChannelMessages) throw new Error(`${adapter.name} cannot read channels`);
      const { messages } = await adapter.fetchChannelMessages(channelId, {
        limit,
        direction: "backward",
        ...(before ? { cursor: slackCursor(before) } : {}),
      });
      return messages.filter(visible).reverse();
    },
  },
};

export interface ChatContextDeps {
  params: ParameterStore;
  oidc: OidcVerifier;
  openChat: (bot: string) => Promise<{ bot: Bot; chat: PosterChat }>;
  requireApprovedChat: (bot: Bot, chatId: string) => Promise<Access>;
  logger: Pick<Logger, "warn">;
}

export function createChatContext({
  params,
  oidc,
  openChat,
  requireApprovedChat,
  logger,
}: ChatContextDeps) {
  const read = async <T>(
    operation: string,
    request: z.output<typeof listThreadsRequestSchema> | z.output<typeof readChannelRequestSchema>,
    limit: number,
    run: (reader: ChannelReader, query: ChannelQuery) => Promise<T>,
  ) => {
    await requireBound(params, oidc, request.token, request.bot);
    const { bot, chat } = await openChat(request.bot);
    const access = await requireApprovedChat(bot, request.chatId);
    const channelId = `${bot.platform}:${request.chatId}`;
    if (chat.thread(request.threadId).channelId !== channelId) {
      throw new Error(`chat ${request.chatId} is not the chat of the dispatched thread`);
    }
    const query = {
      chat,
      channelId,
      limit,
      visible: visibleTo(access, request.includeBots ?? false),
    };
    try {
      return await run(READERS[bot.platform], query);
    } catch (error) {
      logger.warn("chat context read failed", {
        operation,
        bot: bot.name,
        chatId: request.chatId,
        limit,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  };

  return {
    async listThreads(request: z.output<typeof listThreadsRequestSchema>) {
      const limit = request.limit ?? LIST_THREADS_DEFAULT;
      const threads = await read(request.operation, request, limit, (reader, query) =>
        reader.threads(query),
      );
      return { threads };
    },
    async readChannel(request: z.output<typeof readChannelRequestSchema>) {
      const limit = request.limit ?? READ_CHANNEL_DEFAULT;
      const before = request.before ? new Date(request.before) : undefined;
      const found = await read(request.operation, request, limit, (reader, query) =>
        reader.messages({ ...query, before }),
      );
      return { messages: found.slice(0, limit).map(toChannelMessage) };
    },
  };
}
