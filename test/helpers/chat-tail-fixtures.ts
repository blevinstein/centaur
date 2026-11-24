import type { Message } from "chat";
import { vi } from "vitest";
import type { ChatAccess } from "../../src/cli/chat-access.js";
import type { Platform } from "../../src/config/index.js";
import { approvedParameter, repoParameter } from "../../src/lambda/connection-paths.js";
import type { PosterChat } from "../../src/lambda/poster.js";
import type { FakeParameterStore } from "./fake-parameter-store.js";
import { connectionParameters, GARDEN_BOT, SLACK_BOT } from "./receiver-fixtures.js";
import { strictStates } from "./strict-state.js";

export const TAIL_BOT = "garden";
export const TAIL_NOW = new Date(Date.UTC(2026, 0, 2, 4, 0));
export const TAIL_CHAT_ID = "-100500";
export const TAIL_CHANNEL_ID = "C0123";
export const TAIL_USER = "1001";
export const TAIL_STRANGER = "9999";
export const TAIL_TABLE = "centaur-state";

const CONNECTIONS = { telegram: GARDEN_BOT, slack: SLACK_BOT } as const;

export interface TailMessageOptions {
  id?: string;
  userId?: string;
  isBot?: boolean;
  isMe?: boolean;
  text?: string;
  /** Minutes after 03:00 UTC on the fixture day; negative values fall before it. */
  minute?: number;
  attachments?: number;
  topic?: string;
}

export const tailMessage = ({
  id = "m1",
  userId = TAIL_USER,
  isBot = false,
  isMe = false,
  text = `text of ${id}`,
  minute = 30,
  attachments = 0,
  topic = "77",
}: TailMessageOptions = {}) =>
  ({
    id,
    threadId: `telegram:${TAIL_CHAT_ID}:${topic}`,
    text,
    author: { userId, userName: "pat", isBot, isMe },
    metadata: { dateSent: new Date(Date.UTC(2026, 0, 2, 3, minute)) },
    attachments: Array.from({ length: attachments }, () => ({ type: "file" })),
  }) as unknown as Message;

export interface TailAccessOptions {
  /** Stored history per channel ID, newest first, as the state adapter lists it. */
  history?: Record<string, Message[]>;
  /** Slack's `conversations.history` page per channel ID, newest first. */
  pages?: Record<string, Message[]>;
  nextCursor?: string;
  slackError?: unknown;
  env?: NodeJS.ProcessEnv;
  /** The `/centaur/state-table` parameter; null leaves it unset. */
  parameterTable?: string | null;
}

/** `ChatAccess` over in-memory strict state and a scripted chat; no AWS, no network. */
export function fakeChatAccess({
  history = {},
  pages = {},
  nextCursor,
  slackError,
  env = {},
}: Omit<TailAccessOptions, "parameterTable"> = {}) {
  const states = strictStates();
  const fetchChannelMessages = vi.fn(async (channelId: string) => {
    if (slackError) throw slackError;
    return { messages: pages[channelId.slice("slack:".length)] ?? [], nextCursor };
  });
  const createState = vi.fn((_table: string, prefix: string) => states.createState(prefix));
  const access: ChatAccess = {
    env,
    createState,
    chatFor: (bot) =>
      ({
        initialize: async () => {},
        history: {
          thread: {
            async *collect(channelId: string) {
              yield* [...(history[channelId.slice(bot.platform.length + 1)] ?? [])].reverse();
            },
          },
        },
        channel: () => ({
          adapter: { name: bot.platform, fetchChannelMessages },
        }),
      }) as unknown as PosterChat,
  };
  return { access, states, fetchChannelMessages, createState };
}

/** Adds the platform's connection to the bot `garden`, bound, with one approved chat and one enrolled user. */
export async function seedTailBot(
  store: FakeParameterStore,
  platform: Platform,
  chatId = platform === "slack" ? TAIL_CHANNEL_ID : TAIL_CHAT_ID,
) {
  const connection = { ...CONNECTIONS[platform], name: TAIL_BOT };
  const parameters = {
    ...connectionParameters(connection),
    [repoParameter(TAIL_BOT)]: connection.repo,
    [approvedParameter(TAIL_BOT, platform, "chat", chatId)]: "{}",
    [approvedParameter(TAIL_BOT, platform, "user", TAIL_USER)]: "{}",
  };
  for (const [name, value] of Object.entries(parameters)) {
    await store.put(name, value, { secure: false });
  }
}

export const LEAKY_BOT_ID = 424242;
export const LEAKY_BOT_USERNAME = "leaky_bot";

/** Answers Telegram's `getMe` with a recognizable identity, which the adapter logs when it initializes. */
export function stubTelegramIdentity() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: LEAKY_BOT_ID,
              is_bot: true,
              first_name: "Leaky",
              username: LEAKY_BOT_USERNAME,
            },
          }),
        ),
    ),
  );
}
