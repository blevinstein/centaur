import { PLATFORMS, type Platform } from "../config/index.js";
import { BOTS_ROOT, connectionParameter, scopedChatParameter } from "../lambda/connection-paths.js";
import { CHATS_PREFIX } from "../lambda/parameters.js";
import type { CopyPlan } from "./parameter-copy.js";
import type { ParameterStore, StoredParameter } from "./parameter-store.js";

const FLAT_CONNECTION_KEY =
  /^(token|webhook-secret|signing-secret|approved-chats\/[^/]+|approved-users\/[^/]+|blocked\/(chat|user)\/[^/]+)$/;
const APPROVED_CHAT_KEY = /^approved-chats\/([^/]+)$/;
const NESTED_APPROVED_CHAT = /^platforms\/([^/]+)\/approved-chats\/([^/]+)$/;
const PLATFORM_KEY = "platform";
const BOT_LEVEL_KEYS = ["repo"];

const asPlatform = (value: string | undefined) =>
  PLATFORMS.find((candidate) => candidate === value);

export interface MigrationOptions {
  /** Platform for flat aliases whose chat no bot's approvals identify. */
  aliasPlatforms: ReadonlyMap<string, Platform>;
  /** Flat aliases that are deliberately not migrated. */
  droppedAliases: ReadonlySet<string>;
}

export interface UnresolvedAlias {
  alias: string;
  chatId: string;
  candidates: Platform[];
}

export interface MigrationPlan {
  copies: CopyPlan[];
  /** Flat parameters that `--prune` deletes. */
  flat: string[];
  unresolvedAliases: UnresolvedAlias[];
  /** Flat data that cannot be placed; blocks copying and pruning. */
  problems: string[];
  /** Parameters under a bot that match no known layout; neither copied nor pruned. */
  unrecognized: string[];
}

interface BotEntry extends StoredParameter {
  rel: string;
}

function groupByBot(parameters: StoredParameter[]): Map<string, BotEntry[]> {
  const bots = new Map<string, BotEntry[]>();
  for (const parameter of parameters) {
    const [bot, ...rest] = parameter.name.slice(BOTS_ROOT.length + 1).split("/");
    if (!bot || rest.length === 0) continue;
    bots.set(bot, [...(bots.get(bot) ?? []), { ...parameter, rel: rest.join("/") }]);
  }
  return bots;
}

/** Which platforms have approved each chat ID, from the flat and the nested layout alike. */
function approvedChatPlatforms(bots: Map<string, BotEntry[]>): Map<string, Set<Platform>> {
  const byChat = new Map<string, Set<Platform>>();
  const add = (chatId: string, platform: Platform | undefined) => {
    if (platform) byChat.set(chatId, (byChat.get(chatId) ?? new Set()).add(platform));
  };
  for (const entries of bots.values()) {
    const flatPlatform = asPlatform(entries.find(({ rel }) => rel === PLATFORM_KEY)?.value);
    for (const { rel } of entries) {
      const nested = NESTED_APPROVED_CHAT.exec(rel);
      if (nested?.[1] && nested[2]) add(nested[2], asPlatform(nested[1]));
      const flat = APPROVED_CHAT_KEY.exec(rel);
      if (flat?.[1]) add(flat[1], flatPlatform);
    }
  }
  return byChat;
}

export async function planMigration(
  store: ParameterStore,
  { aliasPlatforms, droppedAliases }: MigrationOptions,
): Promise<MigrationPlan> {
  const plan: MigrationPlan = {
    copies: [],
    flat: [],
    unresolvedAliases: [],
    problems: [],
    unrecognized: [],
  };
  const bots = groupByBot(await store.getByPath(`${BOTS_ROOT}/`));

  for (const [bot, entries] of bots) {
    const platformEntry = entries.find(({ rel }) => rel === PLATFORM_KEY);
    const platform = asPlatform(platformEntry?.value);
    const flatEntries = entries.filter(({ rel }) => FLAT_CONNECTION_KEY.test(rel));
    for (const { name, rel } of entries) {
      if (
        rel !== PLATFORM_KEY &&
        !BOT_LEVEL_KEYS.includes(rel) &&
        !rel.startsWith("platforms/") &&
        !FLAT_CONNECTION_KEY.test(rel)
      ) {
        plan.unrecognized.push(name);
      }
    }
    if (!platform) {
      if (platformEntry || flatEntries.length > 0) {
        plan.problems.push(
          `bot "${bot}" has flat parameters but no valid platform parameter (${PLATFORMS.join(" or ")}); fix or remove it`,
        );
      }
      continue;
    }
    for (const entry of flatEntries) {
      plan.copies.push({ source: entry, target: connectionParameter(bot, platform, entry.rel) });
    }
    plan.flat.push(...flatEntries.map(({ name }) => name));
    if (platformEntry) plan.flat.push(platformEntry.name);
  }

  const chatPlatforms = approvedChatPlatforms(bots);
  const flatAliases = (await store.getByPath(`${CHATS_PREFIX}/`)).filter(
    ({ name }) => !name.slice(CHATS_PREFIX.length + 1).includes("/"),
  );
  const aliasNames = new Set(flatAliases.map(({ name }) => name.slice(CHATS_PREFIX.length + 1)));
  for (const alias of [...aliasPlatforms.keys(), ...droppedAliases]) {
    if (!aliasNames.has(alias)) plan.problems.push(`there is no flat chat alias "${alias}"`);
  }
  for (const source of flatAliases) {
    const alias = source.name.slice(CHATS_PREFIX.length + 1);
    if (droppedAliases.has(alias)) {
      plan.flat.push(source.name);
      continue;
    }
    const candidates = [...(chatPlatforms.get(source.value) ?? [])];
    const platform =
      aliasPlatforms.get(alias) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!platform) {
      plan.unresolvedAliases.push({ alias, chatId: source.value, candidates });
      continue;
    }
    plan.copies.push({ source, target: scopedChatParameter(platform, alias) });
    plan.flat.push(source.name);
  }
  return plan;
}
