import { describe, expect, it, vi } from "vitest";
import { createGitHubDispatcher } from "../src/lambda/github.js";
import { readPlatformSettings } from "../src/lambda/registry.js";
import {
  fakeLogger,
  GARDEN_BOT,
  GARDEN_SLACK_BOT,
  registryStateWith,
} from "./helpers/receiver-fixtures.js";

describe("readPlatformSettings", () => {
  it("reads the settings of the connection's platform", async () => {
    const state = await registryStateWith({
      garden: {
        platforms: {
          telegram: { respond_to: "all", handle: "garden_bot", bot_messages: "mention" },
        },
      },
    });

    await expect(readPlatformSettings(state, GARDEN_BOT)).resolves.toEqual({
      respond_to: "all",
      handle: "garden_bot",
      bot_messages: "mention",
    });
  });

  it("reads an entry stored without bot_messages as ignore", async () => {
    const state = await registryStateWith({
      garden: { platforms: { telegram: { respond_to: "all" } } },
    });

    await expect(readPlatformSettings(state, GARDEN_BOT)).resolves.toEqual({
      respond_to: "all",
      bot_messages: "ignore",
    });
  });

  it.each([
    ["an old-shape entry", "legacy", { respond_to: "all" }],
    ["no entry", "fresh", undefined],
    ["an entry that omits the platform", "partial", { platforms: { telegram: {} } }],
  ])("serves nothing for %s and logs the bot once", async (_name, name, entry) => {
    const state = await registryStateWith(entry ? { [name]: entry } : {});
    const logger = fakeLogger();
    const bot = { ...GARDEN_SLACK_BOT, name };

    await expect(readPlatformSettings(state, bot, logger)).resolves.toBeUndefined();
    await readPlatformSettings(state, bot, logger);

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`bot "${name}"`));
  });
});

describe("createGitHubDispatcher", () => {
  it("posts a repository_dispatch with the token and payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await createGitHubDispatcher("ghp_x", fetchImpl).dispatch("octo/garden", "centaur-message", {
      thread_id: "t",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/garden/dispatches");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(init.body as string)).toEqual({
      event_type: "centaur-message",
      client_payload: { thread_id: "t" },
    });
  });

  it("fails with the status code only when GitHub rejects the dispatch", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret detail", { status: 404 }));

    await expect(
      createGitHubDispatcher("ghp_x", fetchImpl).dispatch("octo/garden", "e", {}),
    ).rejects.toThrow("HTTP 404");
  });
});
