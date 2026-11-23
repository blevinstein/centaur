import { type AccessKind, adminParameter, subjectIdOf } from "./access-entries.js";
import { approvedPrefix, blockedPrefix } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";
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

const idsUnder = async (params: ParameterStore, prefix: string) =>
  new Set(Object.keys(await params.getByPath(prefix)).map(subjectIdOf));

const without = (ids: Set<string>, blocked: Set<string>) =>
  new Set([...ids].filter((id) => !blocked.has(id)));

export function createAccessResolver(
  bot: Bot,
  params: ParameterStore,
  ttlMs = ACCESS_CACHE_TTL_MS,
): CachedAccessResolver {
  const approved = (kind: AccessKind) =>
    idsUnder(params, approvedPrefix(bot.name, bot.platform, kind));
  const blocked = (kind: AccessKind) =>
    idsUnder(params, blockedPrefix(bot.name, bot.platform, kind));
  const load = async (): Promise<Access> => {
    const [approvedChats, blockedChatIds, approvedUsers, blockedUsers, adminId] = await Promise.all(
      [
        approved("chat"),
        blocked("chat"),
        approved("user"),
        blocked("user"),
        params.get(adminParameter(bot.platform)),
      ],
    );
    const admins = new Set(adminId ? [adminId] : []);
    const blockedUserIds = without(blockedUsers, admins);
    return {
      chatIds: without(approvedChats, blockedChatIds),
      userIds: without(new Set([...approvedUsers, ...admins]), blockedUserIds),
      blockedChatIds,
      blockedUserIds,
    };
  };
  return cachedFor(ttlMs, load);
}
