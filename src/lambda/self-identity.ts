import type { SlackAdapter } from "@chat-adapter/slack";
import type { Adapter, Logger } from "chat";
import type { Platform } from "../config/index.js";
import { type SelfIdentity, toSelfIdentity } from "../self-identity.js";
import type { RepositoryDispatcher } from "./github.js";
import type { Bot } from "./registry.js";
import type { TelegramApi } from "./telegram.js";
import { cachedFor } from "./ttl-cache.js";

/** A renamed bot is picked up after this long, or on the next cold start. */
export const IDENTITY_TTL_MS = 60 * 60 * 1000;
export const IDENTITY_TIMEOUT_MS = 2000;

type Fetcher = (
  bot: Bot,
  adapter: Adapter,
  telegram: Pick<TelegramApi, "getMe"> | undefined,
) => Promise<SelfIdentity | undefined>;

const FETCHERS: Record<Platform, Fetcher> = {
  slack: async (_bot, adapter) => {
    const slack = adapter as SlackAdapter;
    const { botUserId, userName } = slack;
    const info = botUserId ? await slack.webClient.users.info({ user: botUserId }) : undefined;
    const profile = info?.user?.profile;
    return toSelfIdentity(
      userName,
      profile?.display_name || profile?.real_name || info?.user?.real_name,
    );
  },
  telegram: async (bot, adapter, telegram) => {
    const me = await telegram?.getMe(bot.token);
    if (!me) return toSelfIdentity(adapter.userName);
    return toSelfIdentity(
      me.username,
      [me.first_name, me.last_name].filter(Boolean).join(" ").trim(),
    );
  },
};

const withTimeout = <T>(work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("identity lookup timed out")), IDENTITY_TIMEOUT_MS).unref(),
    ),
  ]);

export type SelfIdentityLookup = (bot: Bot, adapter: Adapter) => Promise<SelfIdentity | undefined>;

/**
 * Resolves the bot's own username and display name on first use and caches them per bot for a
 * warm environment. A failed lookup falls back to the adapter's user name, or to no identity, and
 * is not cached; it never throws.
 */
export function createSelfIdentityLookup({
  telegram,
  logger,
}: {
  telegram?: Pick<TelegramApi, "getMe"> | undefined;
  logger?: Pick<Logger, "warn"> | undefined;
}): SelfIdentityLookup {
  const cached = new Map<string, ReturnType<typeof cachedFor<SelfIdentity | undefined>>>();
  return async (bot, adapter) => {
    const key = `${bot.platform}:${bot.name}`;
    let entry = cached.get(key);
    if (!entry) {
      entry = cachedFor(IDENTITY_TTL_MS, () =>
        withTimeout(FETCHERS[bot.platform](bot, adapter, telegram)),
      );
      cached.set(key, entry);
    }
    try {
      return await entry();
    } catch (error) {
      logger?.warn("could not read the bot's own identity", {
        bot: bot.name,
        platform: bot.platform,
        error,
      });
      return toSelfIdentity(adapter.userName);
    }
  };
}

/** Adds the bot's identity to every dispatch payload when one is known. */
export function withSelfIdentity(
  dispatcher: RepositoryDispatcher,
  identify: () => Promise<SelfIdentity | undefined>,
): RepositoryDispatcher {
  return {
    dispatch: async (repo, eventType, clientPayload) => {
      const self = await identify();
      await dispatcher.dispatch(repo, eventType, self ? { ...clientPayload, self } : clientPayload);
    },
  };
}
