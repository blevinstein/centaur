import { ALIAS_PATTERN, PLATFORMS, type Platform } from "../config/index.js";
import { BOTS_ROOT, botPath, parseBotParameter } from "../lambda/connection-paths.js";
import { chatParameter, GITHUB_TOKEN_PARAMETER } from "../lambda/parameters.js";
import type { ParameterStore } from "./parameter-store.js";

export { chatParameter, GITHUB_TOKEN_PARAMETER, type Platform };

export class CliError extends Error {}

export const PLATFORM_NAMES: readonly Platform[] = PLATFORMS;

/** Which secrets `bot add` reads and which it generates, per platform; names are the parameter keys. */
export const PLATFORM_SECRETS = {
  telegram: { prompted: ["token"], generated: ["webhook-secret"] },
  slack: { prompted: ["token", "signing-secret"], generated: [] },
} as const satisfies Record<
  Platform,
  { prompted: readonly string[]; generated: readonly string[] }
>;

export function parseName(kind: string, value: string): string {
  if (!ALIAS_PATTERN.test(value)) {
    throw new CliError(
      `Invalid ${kind} name "${value}": use lowercase letters, digits, "-" and "_".`,
    );
  }
  return value;
}

export function parsePlatform(value: string): Platform {
  const platform = PLATFORM_NAMES.find((candidate) => candidate === value);
  if (!platform) {
    throw new CliError(
      `Unknown platform "${value}": expected one of ${PLATFORM_NAMES.join(", ")}.`,
    );
  }
  return platform;
}

export function selectedPlatformIds(options: Record<string, string | boolean | undefined>) {
  const ids = PLATFORM_NAMES.flatMap((platform) => {
    const id = options[platform];
    return id ? [{ platform, id: String(id) }] : [];
  });
  if (ids.length === 0) {
    throw new CliError(`Pass at least one of ${PLATFORM_NAMES.map((p) => `--${p}`).join(", ")}.`);
  }
  return ids;
}

/** The keys stored directly under each connection, per bot; a bot with no connection maps to an empty map. */
export type BotConnections = Map<string, Map<Platform, Set<string>>>;

export async function listBotConnections(
  store: ParameterStore,
  bot?: string,
): Promise<BotConnections> {
  const prefix = bot === undefined ? BOTS_ROOT : botPath(bot);
  const byBot: BotConnections = new Map();
  for (const name of await store.listNames(`${prefix}/`)) {
    const parsed = parseBotParameter(name);
    if (!parsed) continue;
    const connections = byBot.get(parsed.bot) ?? new Map<Platform, Set<string>>();
    byBot.set(parsed.bot, connections);
    if (parsed.platform && parsed.key) {
      connections.set(
        parsed.platform,
        (connections.get(parsed.platform) ?? new Set()).add(parsed.key),
      );
    }
  }
  return byBot;
}

export function selectConnection(
  bot: string,
  connections: Iterable<Platform>,
  requested?: string,
): Platform {
  const platforms = [...connections];
  if (requested !== undefined) {
    const platform = parsePlatform(requested);
    if (!platforms.includes(platform)) {
      throw new CliError(`Bot "${bot}" has no ${platform} connection.`);
    }
    return platform;
  }
  const [only] = platforms;
  if (only === undefined) throw new CliError(`Bot "${bot}" has no connections.`);
  if (platforms.length > 1) {
    throw new CliError(
      `Bot "${bot}" has several connections (${platforms.join(", ")}); pass --platform.`,
    );
  }
  return only;
}

/** Resolves the connection a command acts on: `--platform`, or the bot's only connection. */
export async function requireConnection(
  store: ParameterStore,
  bot: string,
  requested?: string,
): Promise<Platform> {
  const connections = (await listBotConnections(store, bot)).get(bot);
  if (!connections) throw new CliError(`Unknown bot "${bot}".`);
  return selectConnection(bot, connections.keys(), requested);
}
