import type { Platform } from "../config/index.js";
import { subjectIdOf } from "./access-entries.js";
import { scopedChatParameter } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";

const ALIAS_MAX_LENGTH = 40;
const ALIAS_ATTEMPTS = 50;

type KnownAliases = Record<string, string>;

export function slugAlias(title: string | undefined, chatId: string): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, ALIAS_MAX_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
  return slug || ["chat", chatId.replaceAll(/\D/g, "").slice(-4)].filter(Boolean).join("-");
}

const suffixed = (base: string, attempt: number) =>
  attempt === 0 ? base : `${base}-${attempt + 1}`;

/** The alias that already names the chat, else the first unused name derived from its title. */
export function proposeChatAlias(
  known: KnownAliases,
  chatId: string,
  title: string | undefined,
): string {
  const existing = Object.entries(known).find(([, id]) => id === chatId)?.[0];
  if (existing) return subjectIdOf(existing);
  const taken = new Set(Object.keys(known).map(subjectIdOf));
  const base = slugAlias(title, chatId);
  for (let attempt = 0; ; attempt++) {
    if (!taken.has(suffixed(base, attempt))) return suffixed(base, attempt);
  }
}

/** Creates the alias without ever replacing one; on a conflict it takes the next free name. */
export async function recordChatAlias(
  params: ParameterStore,
  platform: Platform,
  chatId: string,
  proposed: string,
): Promise<string> {
  for (let attempt = 0; attempt < ALIAS_ATTEMPTS; attempt++) {
    const name = suffixed(proposed, attempt);
    const parameter = scopedChatParameter(platform, name);
    if (await params.putIfAbsent(parameter, chatId)) return name;
    if ((await params.get(parameter)) === chatId) return name;
  }
  throw new Error(`could not allocate a chat alias for ${chatId}`);
}

/** The chat ID an alias names on the bot's platform; aliases on other platforms are not visible. */
export async function resolveChatAlias(
  params: ParameterStore,
  bot: { name: string; platform: Platform },
  alias: string,
): Promise<string> {
  const chatId = await params.get(scopedChatParameter(bot.platform, alias));
  if (!chatId) {
    throw new Error(
      `bot "${bot.name}" has no chat alias "${alias}" on ${bot.platform}; approve the chat under that name with \`centaur access approve ${bot.name} chat <id> --platform ${bot.platform} --alias ${alias}\``,
    );
  }
  return chatId;
}
