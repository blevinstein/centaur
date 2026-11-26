import type { Logger, StateAdapter } from "chat";
import type { z } from "zod";
import {
  MESSAGE_TEXT_MAX,
  SEARCH_CONTEXT_MAX,
  type SearchChatResult,
  type SearchResult,
  type searchChatRequestSchema,
} from "../poster-contract.js";
import { clip } from "../text.js";
import type { Access } from "./access.js";
import { type Author, visibleAuthor } from "./chat-context.js";
import type { PosterChat } from "./poster.js";
import type { Bot } from "./registry.js";
import { createSearchTokenStore, SEARCH_TOKEN_TTL_MS } from "./search-token.js";
import type { SlackSearchApi, SlackSearchMessage } from "./slack-search.js";

export const SEARCH_CHAT_DEFAULT = 10;

const SLACK_PUBLIC_CHANNEL_ID = /^C/;
const EXPIRED_ERRORS = new Set(["invalid_action_token"]);
const NOT_ENABLED_ERRORS = new Set(["feature_not_enabled", "missing_scope"]);
const RATE_LIMITED_ERRORS = new Set(["rate_limited", "ratelimited"]);
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

const toSeconds = (instant: string | undefined) =>
  instant === undefined ? undefined : Math.floor(new Date(instant).getTime() / 1000);

type SearchRequest = z.output<typeof searchChatRequestSchema>;

export interface SearchChatDeps {
  target: (request: SearchRequest) => Promise<{
    bot: Bot;
    chat: PosterChat;
    state: StateAdapter;
    access: Access;
    channelId: string;
  }>;
  searchSlack: SlackSearchApi;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}

const unavailable = (
  reason: Extract<SearchChatResult, { status: "unavailable" }>["reason"],
  extra: { retryAfterSeconds?: number | undefined; tokenAgeSeconds?: number | undefined } = {},
): SearchChatResult => ({
  status: "unavailable",
  reason,
  ...(extra.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: extra.retryAfterSeconds }),
  ...(extra.tokenAgeSeconds === undefined ? {} : { tokenAgeSeconds: extra.tokenAgeSeconds }),
});

export function createSearchChat({
  target,
  searchSlack,
  logger,
  now = () => new Date(),
}: SearchChatDeps) {
  return async (request: SearchRequest): Promise<SearchChatResult> => {
    const { bot, chat, state, access } = await target(request);
    const where = { bot: bot.name, chatId: request.chatId };
    if (bot.platform !== "slack" || !SLACK_PUBLIC_CHANNEL_ID.test(request.chatId)) {
      return unavailable("unsupported");
    }
    const stored = await createSearchTokenStore(state, bot.name).read(request.threadId);
    if (!stored) return unavailable("no_token");
    const tokenAgeSeconds = Math.max(
      0,
      Math.floor((now().getTime() - new Date(stored.capturedAt).getTime()) / 1000),
    );
    if (tokenAgeSeconds * 1000 >= SEARCH_TOKEN_TTL_MS) {
      return unavailable("expired", { tokenAgeSeconds });
    }

    const limit = request.limit ?? SEARCH_CHAT_DEFAULT;
    const response = await searchSlack({
      botToken: bot.token,
      actionToken: stored.token,
      query: request.query,
      channelId: request.chatId,
      limit,
      after: toSeconds(request.after),
      before: toSeconds(request.before),
    });
    if (!response.ok) {
      const code = ERROR_CODE.test(response.error) ? response.error : "unknown_error";
      logger.warn("chat search failed", { ...where, error: code });
      if (EXPIRED_ERRORS.has(code)) return unavailable("expired", { tokenAgeSeconds });
      if (NOT_ENABLED_ERRORS.has(code)) return unavailable("not_enabled");
      if (RATE_LIMITED_ERRORS.has(code)) {
        return unavailable("rate_limited", { retryAfterSeconds: response.retryAfterSeconds });
      }
      throw new Error(`slack search failed: ${code}`);
    }

    const botUserId = (chat.thread(request.threadId).adapter as { botUserId?: string }).botUserId;
    const visible = visibleAuthor(access, request.includeBots ?? false);
    const authorOf = (userId: string, isBot?: boolean): Author => ({
      userId,
      isMe: userId === botUserId,
      ...(isBot === undefined ? {} : { isBot }),
    });
    const results = response.messages
      .filter(({ channel_id }) => channel_id === request.chatId)
      .flatMap((message) => {
        const userId = message.author_user_id;
        if (userId === undefined || !visible(authorOf(userId, message.is_author_bot))) return [];
        return [toResult(message, userId, botUserId, (id) => visible(authorOf(id)))];
      })
      .slice(0, limit);
    logger.info("chat search", {
      ...where,
      found: response.messages.length,
      returned: results.length,
    });
    return { status: "ok", results };
  };
}

type ContextSide = NonNullable<SlackSearchMessage["context_messages"]>["before"];

function toResult(
  message: SlackSearchMessage,
  userId: string,
  botUserId: string | undefined,
  visibleUser: (userId: string) => boolean,
): SearchResult {
  const visibleContext = (entries: ContextSide) =>
    (entries ?? []).flatMap((entry) =>
      entry.user_id !== undefined && visibleUser(entry.user_id)
        ? [
            {
              userId: entry.user_id,
              ts: entry.ts ?? "",
              text: clip(entry.text ?? "", MESSAGE_TEXT_MAX),
            },
          ]
        : [],
    );
  const context = message.context_messages && {
    before: visibleContext(message.context_messages.before).slice(-SEARCH_CONTEXT_MAX),
    after: visibleContext(message.context_messages.after).slice(0, SEARCH_CONTEXT_MAX),
  };
  return {
    channelId: message.channel_id,
    ts: message.message_ts,
    userId,
    ...(message.author_name === undefined ? {} : { userName: message.author_name }),
    fromBot: userId === botUserId,
    text: clip(message.content ?? "", MESSAGE_TEXT_MAX),
    ...(message.permalink === undefined ? {} : { permalink: message.permalink }),
    ...(context ? { context } : {}),
  };
}
