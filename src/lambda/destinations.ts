import { z } from "zod";
import { CONTEXT_POLICIES, type Platform } from "../config/index.js";
import { subjectIdOf } from "./access-entries.js";
import { scopedChatParameter } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";

const NAME_MAX_LENGTH = 40;
const NAME_ATTEMPTS = 50;

const destinationSchema = z.object({
  chatId: z.string().min(1),
  /** The platform thread ID of the persistent thread; absent for a destination with no bound thread. */
  threadId: z.string().min(1).optional(),
  /** The bot that owns `threadId`. */
  bot: z.string().min(1).optional(),
  /** The context policy of the prompt that last posted into `threadId`. */
  context: z.enum(CONTEXT_POLICIES).optional(),
  name: z.string().optional(),
  at: z.string(),
});

export type Destination = z.infer<typeof destinationSchema>;
export type DestinationFields = Omit<Destination, "at">;

export const encodeDestination = (fields: DestinationFields, at = new Date()) =>
  JSON.stringify({ ...fields, at: at.toISOString() });

/** Reads a JSON record, or a bare chat ID as a destination with no thread. */
export function parseDestination(value: string): Destination {
  if (value.trimStart().startsWith("{")) return destinationSchema.parse(JSON.parse(value));
  return { chatId: value, at: "unknown" };
}

export const parseDestinations = (raw: Record<string, string>): Record<string, Destination> =>
  Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, parseDestination(value)]));

export function slugName(title: string | undefined, chatId: string): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, NAME_MAX_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
  return slug || ["chat", chatId.replaceAll(/\D/g, "").slice(-4)].filter(Boolean).join("-");
}

const suffixed = (base: string, attempt: number) =>
  attempt === 0 ? base : `${base}-${attempt + 1}`;

/** The name of the thread-less destination that already holds the chat, else the first unused name derived from its title. */
export function proposeDestinationName(
  known: Record<string, Destination>,
  chatId: string,
  title: string | undefined,
): string {
  const existing = Object.entries(known).find(
    ([, destination]) => destination.chatId === chatId && destination.threadId === undefined,
  )?.[0];
  if (existing) return subjectIdOf(existing);
  const taken = new Set(Object.keys(known).map(subjectIdOf));
  const base = slugName(title, chatId);
  for (let attempt = 0; ; attempt++) {
    if (!taken.has(suffixed(base, attempt))) return suffixed(base, attempt);
  }
}

/** Creates the destination without ever replacing one; on a conflict it takes the next free name. */
export async function recordDestination(
  params: ParameterStore,
  platform: Platform,
  fields: DestinationFields,
  proposed: string,
): Promise<string> {
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const name = suffixed(proposed, attempt);
    const parameter = scopedChatParameter(platform, name);
    if (await params.putIfAbsent(parameter, encodeDestination(fields))) return name;
    const existing = await params.get(parameter);
    if (existing !== undefined && parseDestination(existing).chatId === fields.chatId) return name;
  }
  throw new Error(`could not allocate a destination name for ${fields.chatId}`);
}

export async function saveDestination(
  params: ParameterStore,
  platform: Platform,
  name: string,
  fields: DestinationFields,
) {
  await params.put(scopedChatParameter(platform, name), encodeDestination(fields));
}

interface Connection {
  name: string;
  platform: Platform;
}

/** The destination a name holds on the bot's platform, if any; other platforms' names are not visible. */
export async function resolveDestination(
  params: ParameterStore,
  bot: Connection,
  name: string,
): Promise<Destination | undefined> {
  const stored = await params.get(scopedChatParameter(bot.platform, name));
  if (stored === undefined) return undefined;
  const destination = parseDestination(stored);
  if (destination.threadId && destination.bot && destination.bot !== bot.name) {
    throw new Error(
      `destination "${name}" on ${bot.platform} is bound to a thread owned by bot "${destination.bot}", not "${bot.name}"`,
    );
  }
  return destination;
}

/**
 * Creates the destination in the connection's only approved group chat; with none or several the
 * bot cannot choose, so it fails naming the command that binds the name to a chat.
 */
export async function createDestinationOnFirstUse(
  params: ParameterStore,
  bot: Connection,
  name: string,
  approvedChatIds: Iterable<string>,
): Promise<Destination> {
  const chatIds = [...approvedChatIds];
  const bindWith = `\`centaur destination set ${bot.name} ${name} --platform ${bot.platform} --chat <id>\``;
  const missing = `bot "${bot.name}" has no destination "${name}" on ${bot.platform}`;
  const [chatId] = chatIds;
  if (chatId === undefined) {
    throw new Error(
      `${missing} and no approved chat to create it in; approve a chat with \`centaur access approve ${bot.name} chat <id> --platform ${bot.platform}\`, then bind the name with ${bindWith}`,
    );
  }
  if (chatIds.length > 1) {
    throw new Error(
      `${missing} and has several approved chats, so it cannot choose one; bind the name to a chat with ${bindWith}`,
    );
  }
  await params.putIfAbsent(scopedChatParameter(bot.platform, name), encodeDestination({ chatId }));
  return (await resolveDestination(params, bot, name)) ?? { chatId, at: "unknown" };
}
