import type { Logger, StateAdapter } from "chat";
import type { Platform, PlatformSettings } from "../config/index.js";
import {
  BOTS_ROOT,
  botPath,
  parseBotParameter,
  repoParameter,
  WEBHOOK_SECRET_KEY,
} from "./connection-paths.js";
import type { OidcVerifier } from "./oidc.js";
import type { ReadableParameters } from "./parameters.js";

export { repoParameter };

/** The connection view: one bot's presence on one platform, with the bot's repo binding. */
export interface Bot {
  name: string;
  platform: Platform;
  repo: string;
  token: string;
  webhookSecret: string;
}

export type BotSecrets = Omit<Bot, "repo">;

/** A bot's registry entry: the settings of each connection its repo declares. */
export interface RegistryEntry {
  platforms: Partial<Record<Platform, PlatformSettings>>;
}

export const registryKey = (bot: string) => `registry:${bot}`;
export const botStatePrefix = (bot: string) => `bot:${bot}:`;

export const isBoundTo = async (params: ReadableParameters, bot: string, repository: string) =>
  (await params.get(repoParameter(bot))) === repository;

/** Verifies the OIDC token and requires the bot to be bound to its repository. */
export async function requireBound(
  params: ReadableParameters,
  oidc: OidcVerifier,
  token: string,
  bot: string,
) {
  const { repository } = await oidc.verify(token);
  if (!(await isBoundTo(params, bot, repository))) {
    throw new Error(`bot "${bot}" is not bound to ${repository}`);
  }
  return repository;
}

interface BotRecord {
  repo?: string;
  connections: Map<Platform, Record<string, string>>;
}

export interface LoadOptions {
  /** Selects one connection; without it, a bot with exactly one connection is selected. */
  platform?: Platform;
  /** Receives the warning for a bot with no connection, once per bot per container. */
  logger?: Pick<Logger, "warn">;
}

const warnedBots = new Set<string>();

function groupByBot(entries: Record<string, string>) {
  const byBot = new Map<string, BotRecord>();
  for (const [name, value] of Object.entries(entries)) {
    const parsed = parseBotParameter(name);
    if (!parsed) continue;
    const record: BotRecord = byBot.get(parsed.bot) ?? { connections: new Map() };
    byBot.set(parsed.bot, record);
    if (parsed.platform && parsed.key) {
      const found = record.connections.get(parsed.platform) ?? {};
      record.connections.set(parsed.platform, { ...found, [parsed.key]: value });
    } else if (parsed.key === "repo") {
      record.repo = value;
    }
  }
  return byBot;
}

function secretsOf(name: string, { connections }: BotRecord): BotSecrets[] {
  return [...connections].flatMap(([platform, found]) => {
    const { token } = found;
    const webhookSecret = found[WEBHOOK_SECRET_KEY[platform]];
    return token && webhookSecret ? { name, platform, token, webhookSecret } : [];
  });
}

function pick(secrets: BotSecrets[], platform?: Platform) {
  if (platform) return secrets.find((candidate) => candidate.platform === platform);
  return secrets.length === 1 ? secrets[0] : undefined;
}

async function readBots(params: ReadableParameters, path: string, logger?: LoadOptions["logger"]) {
  const bots = new Map<string, { repo?: string; secrets: BotSecrets[] }>();
  for (const [name, record] of groupByBot(await params.getByPath(path))) {
    const secrets = secretsOf(name, record);
    if (secrets.length === 0 && logger && !warnedBots.has(name)) {
      warnedBots.add(name);
      logger.warn(`bot "${name}" has no connection under ${botPath(name)}/platforms; not served`);
    }
    bots.set(name, { ...(record.repo ? { repo: record.repo } : {}), secrets });
  }
  return bots;
}

/** One connection view for every connection of every bound bot. */
export async function loadBots(
  params: ReadableParameters,
  logger?: LoadOptions["logger"],
): Promise<Bot[]> {
  const bots = await readBots(params, BOTS_ROOT, logger);
  return [...bots.values()].flatMap(({ repo, secrets }) =>
    repo ? secrets.map((connection) => ({ ...connection, repo })) : [],
  );
}

export async function loadBot(
  params: ReadableParameters,
  name: string,
  { platform, logger }: LoadOptions = {},
): Promise<Bot | undefined> {
  const found = (await readBots(params, botPath(name), logger)).get(name);
  const connection = found && pick(found.secrets, platform);
  return connection && found.repo ? { ...connection, repo: found.repo } : undefined;
}

export async function loadBotBinding(
  params: ReadableParameters,
  name: string,
  { platform, logger }: LoadOptions = {},
): Promise<{ secrets: BotSecrets | undefined; repo: string | undefined }> {
  const found = (await readBots(params, botPath(name), logger)).get(name);
  return { secrets: found && pick(found.secrets, platform), repo: found?.repo };
}

export async function readRegistryEntry(
  state: StateAdapter,
  bot: string,
): Promise<RegistryEntry | null> {
  return state.get<RegistryEntry>(registryKey(bot));
}

const warnedUnregistered = new Set<string>();

/** The connection's settings; undefined when the entry does not list it, as with the old shape. An entry
 * stored before `bot_messages` existed reads as `ignore`; keys the schema no longer
 * defines (an old `handle`) are dropped. */
export async function readPlatformSettings(
  state: StateAdapter,
  { name, platform }: Pick<Bot, "name" | "platform">,
  logger?: Pick<Logger, "warn">,
): Promise<PlatformSettings | undefined> {
  const stored = (await readRegistryEntry(state, name))?.platforms?.[platform];
  const entry = stored && {
    respond_to: stored.respond_to,
    bot_messages: stored.bot_messages ?? "ignore",
  };
  if (!entry && logger && !warnedUnregistered.has(name)) {
    warnedUnregistered.add(name);
    logger.warn(`bot "${name}" has no registry entry for a connection; not served until register`);
  }
  return entry;
}

export async function writeRegistryEntry(
  state: StateAdapter,
  bot: string,
  entry: RegistryEntry,
): Promise<void> {
  await state.set(registryKey(bot), entry);
}

/** The bot's connection on `platform` (or its only one); fails naming the bot and what is missing. */
export async function requireBot(
  params: ReadableParameters,
  name: string,
  options: LoadOptions = {},
): Promise<Bot> {
  const bot = await loadBot(params, name, options);
  if (bot) return bot;
  const found = (await readBots(params, botPath(name))).get(name);
  const platforms = found?.secrets.map((connection) => connection.platform) ?? [];
  if (!found?.repo || platforms.length === 0) throw new Error(`unknown or unbound bot "${name}"`);
  if (options.platform) {
    throw new Error(`bot "${name}" has no connection on platform "${options.platform}"`);
  }
  throw new Error(
    `bot "${name}" has several connections (${platforms.join(", ")}); platform is required`,
  );
}
