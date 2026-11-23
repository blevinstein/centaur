import { vi } from "vitest";
import {
  GARDEN_REPOSITORY,
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_CHANNEL_ID,
  TOPIC_ID,
} from "./poster-fixtures.js";

export const NOTES_REPOSITORY = "octo/notes";
export const ENROLLED_USER = "1001";
export const STRANGER = "9999";
export const OTHER_BOT_USER = "B777";
export const GARDEN_CHANNEL = `telegram:${HOUSEHOLD_CHAT_ID}`;
export const GARDEN_THREAD = `${GARDEN_CHANNEL}:${TOPIC_ID}`;
export const SLACK_CHANNEL = `slack:${SLACK_CHANNEL_ID}`;
export const SLACK_THREAD = `${SLACK_CHANNEL}:1700000000.000100`;

export const TELEGRAM_TARGET = {
  token: "jwt",
  bot: "garden",
  chatId: HOUSEHOLD_CHAT_ID,
  threadId: GARDEN_THREAD,
} as const;

export const SLACK_TARGET = {
  token: "jwt",
  bot: "notes",
  chatId: SLACK_CHANNEL_ID,
  threadId: SLACK_THREAD,
} as const;

export interface ContextMessageOptions {
  id?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  isBot?: boolean;
  isMe?: boolean;
  text?: string;
  minute?: number;
}

export const contextMessage = ({
  id = "m1",
  threadId = GARDEN_THREAD,
  userId = ENROLLED_USER,
  userName = "pat",
  isBot = false,
  isMe = false,
  text = `text of ${id}`,
  minute = 0,
}: ContextMessageOptions = {}) => ({
  id,
  threadId,
  text,
  author: { userId, userName, isBot, isMe },
  metadata: { dateSent: new Date(Date.UTC(2026, 0, 2, 3, minute)) },
});

/** The result's scanned range for a read whose oldest message was sent at the given minute. */
export const transcriptMessage = (options: ContextMessageOptions = {}) => ({
  ...contextMessage(options),
  attachments: [],
});

export const scannedRange = (minute: number | null, exhausted: boolean) => ({
  oldest: minute === null ? null : new Date(Date.UTC(2026, 0, 2, 3, minute)).toISOString(),
  exhausted,
});

export const listedThread = (
  options: ContextMessageOptions & { replyCount?: number; lastReplyMinute?: number } = {},
) => {
  const rootMessage = contextMessage(options);
  return {
    id: rootMessage.threadId,
    rootMessage,
    replyCount: options.replyCount,
    lastReplyAt:
      options.lastReplyMinute === undefined
        ? undefined
        : new Date(Date.UTC(2026, 0, 2, 3, options.lastReplyMinute)),
  };
};

/** Poster wired for chat-context calls: the dispatched thread lives in the given channel. */
export async function contextSetup(
  options: {
    platform?: "telegram" | "slack";
    history?: ReturnType<typeof contextMessage>[];
    /** The stored transcript the poster's `read` returns. */
    transcript?: ReturnType<typeof transcriptMessage>[];
    threads?: ReturnType<typeof listedThread>[];
    channelPage?: ReturnType<typeof contextMessage>[];
    /** Cursor to older Slack history, as returned when more remains. */
    nextCursor?: string;
    repository?: string;
    parameters?: Record<string, string>;
  } = {},
) {
  const platform = options.platform ?? "telegram";
  const setup = await posterSetup({
    repository: options.repository ?? (platform === "slack" ? NOTES_REPOSITORY : GARDEN_REPOSITORY),
    parameters: {
      "/centaur/bots/garden/platforms/telegram/approved-users/1001": "{}",
      "/centaur/bots/notes/platforms/slack/approved-users/1001": "{}",
      ...options.parameters,
    },
    ...(options.transcript ? { transcript: options.transcript } : {}),
  });
  const listThreads = vi.fn(async () => ({
    threads: options.threads ?? [],
    nextCursor: options.nextCursor,
  }));
  const fetchChannelMessages = vi.fn(async () => ({
    messages: options.channelPage ?? [],
    nextCursor: options.nextCursor,
  }));
  const history = options.history ?? [];
  setup.chatMock.channel.mockReturnValue({
    post: setup.channelPost,
    messages: {
      async *[Symbol.asyncIterator]() {
        yield* history;
      },
    },
    adapter: { name: platform, listThreads, fetchChannelMessages },
  } as never);
  Object.assign(setup.thread, {
    channelId: platform === "slack" ? SLACK_CHANNEL : GARDEN_CHANNEL,
  });
  return { ...setup, listThreads, fetchChannelMessages };
}
