import type { Message } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "../lambda/access.js";
import {
  READ_CHANNEL_MAX,
  readChannelMessages,
  type Scan,
  toScanned,
  visibleTo,
} from "../lambda/chat-context.js";
import { STATE_TABLE_PARAMETER } from "../lambda/parameters.js";
import { botStatePrefix, requireBot } from "../lambda/registry.js";
import { connectState } from "../lambda/state.js";
import { clip } from "../lambda/text.js";
import { threadKey } from "../thread-key.js";
import type { ChatAccess } from "./chat-access.js";
import type { ParameterStore } from "./parameter-store.js";
import { CliError } from "./registry.js";

export const STATE_TABLE_ENV = "CENTAUR_STATE_TABLE";
export const DEFAULT_MINUTES = 60;
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = READ_CHANNEL_MAX;
export const TEXT_MAX = 120;

const MINUTE_MS = 60_000;

export const TELEGRAM_NOTE =
  "Telegram: the bot's own posts are stored per thread and are not listed here.";

export interface TailOptions {
  platform?: string | undefined;
  minutes: number;
  limit: number;
  table?: string | undefined;
}

export function parseCount(flag: string, value: string, max = Number.MAX_SAFE_INTEGER): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new CliError(`${flag} must be a whole number of at least 1.`);
  }
  return Math.min(count, max);
}

/** The state table: `--table`, else `CENTAUR_STATE_TABLE`, else the SSM parameter the stack publishes. */
export async function resolveTableName(
  store: ParameterStore,
  env: NodeJS.ProcessEnv,
  table: string | undefined,
): Promise<string> {
  const found = table || env[STATE_TABLE_ENV] || (await store.get(STATE_TABLE_PARAMETER));
  if (!found) {
    throw new CliError(
      `No state table: pass --table, set ${STATE_TABLE_ENV}, or deploy the stack that publishes ${STATE_TABLE_PARAMETER}.`,
    );
  }
  return found;
}

/** Slack's API error code, else the error's type; never its message, which may carry request details. */
const errorCode = (error: unknown) => {
  const { code, data } = error as { code?: unknown; data?: { error?: unknown } };
  if (code === "slack_webapi_platform_error" && typeof data?.error === "string") return data.error;
  return error instanceof Error ? error.name : typeof error;
};

export interface Tail {
  platform: Platform;
  messages: Message[];
  dropped: number;
  scan: Scan;
}

/** The recent messages the poster's `read-channel` would show for each of the connection's approved chats. */
export async function readTail(
  store: ParameterStore,
  chatAccess: ChatAccess,
  bot: string,
  platform: Platform,
  options: TailOptions,
): Promise<Tail> {
  const params = {
    get: (name: string) => store.get(name),
    getByPath: async (path: string) =>
      Object.fromEntries((await store.getByPath(path)).map(({ name, value }) => [name, value])),
  };
  const connection = await requireBot(params, bot, { platform });
  const access = await createAccessResolver(connection, params)();
  const tableName = await resolveTableName(store, chatAccess.env, options.table);
  const state = await connectState(
    chatAccess.createState(tableName, botStatePrefix(connection.name)),
  );
  const chat = chatAccess.chatFor(connection, state);
  await chat.initialize();

  const since = new Date(Date.now() - options.minutes * MINUTE_MS);
  const enrolled = visibleTo(access, false);
  const tail: Tail = {
    platform,
    messages: [],
    dropped: 0,
    scan: { oldest: undefined, exhausted: true },
  };
  const visible = (message: Message) => {
    if (message.metadata.dateSent < since) return false;
    if (enrolled(message)) return true;
    tail.dropped += 1;
    return false;
  };
  for (const chatId of access.chatIds) {
    try {
      const { found, scan } = await readChannelMessages(platform, {
        chat,
        channelId: `${platform}:${chatId}`,
        limit: options.limit,
        visible,
      });
      tail.messages.push(...found);
      const { oldest } = scan;
      if (oldest && (!tail.scan.oldest || oldest < tail.scan.oldest)) tail.scan.oldest = oldest;
      tail.scan.exhausted &&= scan.exhausted;
    } catch (error) {
      throw new CliError(`Reading ${platform} history failed: ${errorCode(error)}.`);
    }
  }
  tail.messages.sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
  tail.messages = tail.messages.slice(-options.limit);
  return tail;
}

const isoSeconds = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

const alignColumns = (rows: string[][]) => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
};

/** One line per message, oldest first, then the summary. Chat, thread and user IDs appear only as thread keys. */
export function formatTail(
  bot: string,
  { platform, messages, dropped, scan }: Tail,
  withText: boolean,
) {
  const header = ["time (UTC)", "platform", "author", "thread", "files", "chars"];
  const rows = messages.map((message) => [
    isoSeconds(message.metadata.dateSent),
    platform,
    message.author.isMe || message.author.isBot ? "bot" : "user",
    threadKey(bot, message.threadId),
    String(message.attachments.length),
    String(message.text.length),
    ...(withText ? [clip(message.text.replace(/\s+/g, " ").trim(), TEXT_MAX)] : []),
  ]);
  const { oldest, exhausted } = toScanned(scan);
  return [
    ...alignColumns([[...header, ...(withText ? ["text"] : [])], ...rows]),
    `${messages.length} shown, ${dropped} dropped by the sender filter; oldest examined ${oldest ?? "none"}; window ${exhausted ? "exhausted" : "not exhausted"}.`,
    ...(platform === "telegram" ? [TELEGRAM_NOTE] : []),
  ];
}
