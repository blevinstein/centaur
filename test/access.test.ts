import { describe, expect, it, vi } from "vitest";
import { ACCESS_CACHE_TTL_MS, createAccessResolver } from "../src/lambda/access.js";
import { approvedParameter, blockedParameter } from "../src/lambda/connection-paths.js";
import { cachedFor } from "../src/lambda/ttl-cache.js";
import {
  fakeParameterStore,
  GARDEN_BOT,
  GARDEN_SLACK_BOT,
  GARDEN_SLACK_PARAMETERS,
  PARAMETERS,
} from "./helpers/receiver-fixtures.js";

const resolverWith = async (extra: Record<string, string>) => {
  const params = fakeParameterStore({ ...PARAMETERS, ...extra });
  const resolve = createAccessResolver(GARDEN_BOT, params);
  return { params, resolve };
};

describe("effective access", () => {
  it("unions the admin with approved chats and users of this bot only", async () => {
    const { resolve } = await resolverWith({
      "/centaur/admin/telegram": "5001",
      "/centaur/bots/garden/platforms/telegram/approved-chats/-100900": "{}",
      "/centaur/bots/garden/platforms/telegram/approved-users/2002": "{}",
      "/centaur/bots/other/platforms/telegram/approved-users/3003": "{}",
    });

    const access = await resolve();

    expect(access.chatIds).toEqual(new Set(["-100900"]));
    expect(access.userIds).toEqual(new Set(["5001", "2002"]));
  });

  it("lets a block win over approvals", async () => {
    const { resolve } = await resolverWith({
      "/centaur/bots/garden/platforms/telegram/approved-chats/-100500": "{}",
      "/centaur/bots/garden/platforms/telegram/approved-users/2002": "{}",
      "/centaur/bots/garden/platforms/telegram/blocked/user/2002": "{}",
      "/centaur/bots/garden/platforms/telegram/blocked/user/1001": "{}",
      "/centaur/bots/garden/platforms/telegram/blocked/chat/-100500": "{}",
    });

    const access = await resolve();

    expect(access.userIds.size).toBe(0);
    expect(access.chatIds.size).toBe(0);
    expect(access.blockedUserIds).toEqual(new Set(["2002", "1001"]));
    expect(access.blockedChatIds).toEqual(new Set(["-100500"]));
  });

  it("always allows the platform admin, whom a block cannot lock out", async () => {
    const { resolve } = await resolverWith({
      "/centaur/admin/telegram": "5001",
      "/centaur/bots/garden/platforms/telegram/blocked/user/5001": "{}",
      "/centaur/bots/garden/platforms/telegram/blocked/user/1001": "{}",
    });

    const access = await resolve();

    expect(access.userIds).toEqual(new Set(["5001"]));
    expect(access.blockedUserIds).toEqual(new Set(["1001"]));
  });

  it("does not treat another platform's admin as allowed", async () => {
    const { resolve } = await resolverWith({ "/centaur/admin/slack": "U1" });

    expect((await resolve()).userIds.has("U1")).toBe(false);
  });

  it("keeps a bot's connections independent", async () => {
    const params = fakeParameterStore({
      ...PARAMETERS,
      ...GARDEN_SLACK_PARAMETERS,
      [approvedParameter("garden", "telegram", "user", "2002")]: "{}",
      [approvedParameter("garden", "slack", "user", "U1")]: "{}",
      [blockedParameter("garden", "slack", "chat", "C9")]: "{}",
    });

    const telegram = await createAccessResolver(GARDEN_BOT, params)();
    const slack = await createAccessResolver(GARDEN_SLACK_BOT, params)();

    expect(telegram.userIds).toEqual(new Set(["2002"]));
    expect(telegram.blockedChatIds.size).toBe(0);
    expect(slack.userIds).toEqual(new Set(["U1"]));
    expect(slack.blockedChatIds).toEqual(new Set(["C9"]));
  });

  it("allows nobody without an admin or approvals", async () => {
    const { resolve } = await resolverWith({});

    const access = await resolve();

    expect(access.userIds.size + access.chatIds.size).toBe(0);
  });
});

describe("access cache", () => {
  it("serves the same result within the TTL and reloads after it", async () => {
    vi.useFakeTimers();
    try {
      const { params, resolve } = await resolverWith({});
      const get = vi.spyOn(params, "getByPath");

      await resolve();
      const calls = get.mock.calls.length;
      await resolve();
      expect(get.mock.calls.length).toBe(calls);

      vi.advanceTimersByTime(ACCESS_CACHE_TTL_MS + 1);
      await resolve();
      expect(get.mock.calls.length).toBe(calls * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a new approval after invalidation without waiting for the TTL", async () => {
    const { params, resolve } = await resolverWith({});
    expect((await resolve()).userIds.has("2002")).toBe(false);
    await params.put("/centaur/bots/garden/platforms/telegram/approved-users/2002", "{}");
    expect((await resolve()).userIds.has("2002")).toBe(false);

    resolve.invalidate();

    expect((await resolve()).userIds.has("2002")).toBe(true);
  });

  it("does not cache a failed load", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("throttled"));
    load.mockResolvedValue("ok");
    const cached = cachedFor(1000, load);

    await expect(cached()).rejects.toThrow("throttled");
    await expect(cached()).resolves.toBe("ok");
    await expect(cached()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
