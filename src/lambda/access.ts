import type { StateAdapter } from "chat";
import {
  type AccessKind,
  adminParameter,
  approvedPrefix,
  blockedPrefix,
  subjectIdOf,
} from "./access-entries.js";
import { chatParameter, type ParameterStore, userParameter } from "./parameters.js";
import { type Bot, readRegistryEntry, registeredChats } from "./registry.js";
import { cachedFor } from "./ttl-cache.js";

export const ACCESS_CACHE_TTL_MS = 30_000;

export interface Access {
  userIds: Set<string>;
  chatIds: Set<string>;
  blockedUserIds: Set<string>;
  blockedChatIds: Set<string>;
}

export type AccessResolver = () => Promise<Access>;
export type CachedAccessResolver = AccessResolver & { invalidate(): void };

async function lookup(params: ParameterStore, names: string[]) {
  const values = await Promise.all(names.map((name) => params.get(name)));
  return new Set(values.filter((id): id is string => id !== undefined));
}

const idsUnder = async (params: ParameterStore, prefix: string) =>
  new Set(Object.keys(await params.getByPath(prefix)).map(subjectIdOf));

const without = (ids: Set<string>, blocked: Set<string>) =>
  new Set([...ids].filter((id) => !blocked.has(id)));

export function createAccessResolver(
  bot: Bot,
  params: ParameterStore,
  registryState: StateAdapter,
  ttlMs = ACCESS_CACHE_TTL_MS,
): CachedAccessResolver {
  const approved = (kind: AccessKind) => idsUnder(params, approvedPrefix(bot.name, kind));
  const blocked = (kind: AccessKind) => idsUnder(params, blockedPrefix(bot.name, kind));
  const load = async (): Promise<Access> => {
    const entry = await readRegistryEntry(registryState, bot.name);
    const [
      baselineUsers,
      baselineChats,
      approvedChats,
      blockedChatIds,
      approvedUsers,
      blockedUsers,
      adminId,
    ] = await Promise.all([
      lookup(
        params,
        (entry?.allow ?? []).map((name) => userParameter(name, bot.platform)),
      ),
      lookup(params, registeredChats(entry).map(chatParameter)),
      approved("chat"),
      blocked("chat"),
      approved("user"),
      blocked("user"),
      params.get(adminParameter(bot.platform)),
    ]);
    const admins = new Set(adminId ? [adminId] : []);
    const blockedUserIds = without(blockedUsers, admins);
    return {
      chatIds: without(new Set([...baselineChats, ...approvedChats]), blockedChatIds),
      userIds: without(new Set([...baselineUsers, ...approvedUsers, ...admins]), blockedUserIds),
      blockedChatIds,
      blockedUserIds,
    };
  };
  return cachedFor(ttlMs, load);
}
