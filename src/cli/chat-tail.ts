import type { Message } from "chat";
import type { Platform } from "../config/index.js";
import { createAccessResolver } from "../lambda/access.js";
import { readChannelMessages, type Scan, toScanned, visibleTo } from "../lambda/chat-context.js";
import { STATE_TABLE_PARAMETER } from "../lambda/parameters.js";
import type { PosterChat } from "../lambda/poster.js";
import { botStatePrefix, requireBot } from "../lambda/registry.js";
import { connectState } from "../lambda/state.js";
import { READ_CHANNEL_MAX } from "../poster-contract.js";
import { clip } from "../text.js";
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

export const MAX_REPLY_THREADS = 20;

export interface TailOptions {
  platform?: string | undefined;
  minutes: number;
  limit: number;
  table?: string | undefined;
  replies?: boolean | undefined;
  reactions?: boolean | undefined;
}

/** The parts of a Slack message the tail reads from the adapter's `raw`. */
interface SlackRaw {
  reply_count?: number;
  reactions?: { name: string; count: number }[];
}

const slackRaw = (message: Message) => (message.raw ?? {}) as SlackRaw;

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
  /** The listed messages that are thread replies rather than channel-level messages. */
  replies: Set<Message>;
  notes: string[];
}

/**
 * Adds the replies of the newest `MAX_REPLY_THREADS` listed messages that have any, one
 * `conversations.replies` read each, through the same filter. A thread that fails to read is noted.
 */
async function readReplies(
  chat: PosterChat,
  roots: { channelId: string; message: Message }[],
  limit: number,
  visible: (message: Message) => boolean,
  tail: Tail,
) {
  const threads = roots
    .filter(({ message }) => (slackRaw(message).reply_count ?? 0) > 0)
    .sort((a, b) => b.message.metadata.dateSent.getTime() - a.message.metadata.dateSent.getTime());
  if (threads.length > MAX_REPLY_THREADS) {
    tail.notes.push(
      `Replies read for the newest ${MAX_REPLY_THREADS} of ${threads.length} threads; older threads' replies are not shown.`,
    );
  }
  for (const { channelId, message: root } of threads.slice(0, MAX_REPLY_THREADS)) {
    try {
      const { adapter } = chat.channel(channelId);
      const { messages } = await adapter.fetchMessages(root.threadId, {
        limit,
        direction: "backward",
      });
      for (const reply of messages.filter((candidate) => candidate.id !== root.id)) {
        if (!visible(reply)) continue;
        tail.messages.push(reply);
        tail.replies.add(reply);
      }
    } catch (error) {
      tail.notes.push(`Replies of one thread not read: ${errorCode(error)}.`);
    }
  }
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
    replies: new Set(),
    notes: [],
  };
  const roots: { channelId: string; message: Message }[] = [];
  const visible = (message: Message) => {
    if (message.metadata.dateSent < since) return false;
    if (enrolled(message)) return true;
    tail.dropped += 1;
    return false;
  };
  for (const chatId of access.chatIds) {
    const channelId = `${platform}:${chatId}`;
    try {
      const { found, scan } = await readChannelMessages(platform, {
        chat,
        channelId,
        limit: options.limit,
        visible,
      });
      tail.messages.push(...found);
      roots.push(...found.map((message) => ({ channelId, message })));
      const { oldest } = scan;
      if (oldest && (!tail.scan.oldest || oldest < tail.scan.oldest)) tail.scan.oldest = oldest;
      tail.scan.exhausted &&= scan.exhausted;
    } catch (error) {
      throw new CliError(`Reading ${platform} history failed: ${errorCode(error)}.`);
    }
  }
  if (options.replies) {
    if (platform === "slack") await readReplies(chat, roots, options.limit, visible, tail);
    else
      tail.notes.push(
        "Telegram stores every thread's messages in the chat's list; --replies adds nothing.",
      );
  }
  if (options.reactions && platform !== "slack") {
    tail.notes.push("Telegram does not store reactions; --reactions shows none.");
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

export interface FormatOptions {
  text?: boolean | undefined;
  replies?: boolean | undefined;
  reactions?: boolean | undefined;
}

type Column = [title: string, cell: (message: Message) => string];

/** `name xN` per reaction, names only: the users who reacted are never read. */
const reactionNames = (message: Message) =>
  (slackRaw(message).reactions ?? []).map(({ name, count }) => `${name} x${count}`).join(", ");

/**
 * One line per message, oldest first, then the notes and the summary. Chat, thread and user IDs
 * appear only as thread keys.
 */
export function formatTail(
  bot: string,
  { platform, messages, dropped, scan, replies, notes }: Tail,
  { text = false, replies: withReplies = false, reactions = false }: FormatOptions = {},
) {
  const columns: Column[] = [
    ["time (UTC)", (message) => isoSeconds(message.metadata.dateSent)],
    ["platform", () => platform],
    ["author", ({ author }) => (author.isMe || author.isBot ? "bot" : "user")],
    ["thread", (message) => threadKey(bot, message.threadId)],
  ];
  if (withReplies) columns.push(["kind", (message) => (replies.has(message) ? "reply" : "post")]);
  columns.push(
    ["files", (message) => String(message.attachments.length)],
    ["chars", (message) => String(message.text.length)],
  );
  if (reactions) columns.push(["reactions", reactionNames]);
  if (text) {
    columns.push(["text", (message) => clip(message.text.replace(/\s+/g, " ").trim(), TEXT_MAX)]);
  }
  const { oldest, exhausted } = toScanned(scan);
  return [
    ...alignColumns([
      columns.map(([title]) => title),
      ...messages.map((message) => columns.map(([, cell]) => cell(message))),
    ]),
    ...notes,
    `${messages.length} shown, ${dropped} dropped by the sender filter; oldest examined ${oldest ?? "none"}; window ${exhausted ? "exhausted" : "not exhausted"}.`,
  ];
}
