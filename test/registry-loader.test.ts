import { describe, expect, it } from "vitest";
import {
  approvedParameter,
  repoParameter,
  tokenParameter,
} from "../src/lambda/connection-paths.js";
import { loadBot, loadBotBinding, loadBots } from "../src/lambda/registry.js";
import {
  connectionParameters,
  FLAT_PARAMETERS,
  fakeLogger,
  fakeParameterStore,
  GARDEN_BOT,
  GARDEN_SLACK_BOT,
  PARAMETERS,
  SLACK_BOT,
  twoConnections,
} from "./helpers/receiver-fixtures.js";

describe("loadBots", () => {
  it("returns one view per connection of every bound bot, from the nested layout", async () => {
    const bots = await loadBots(fakeParameterStore());

    expect(bots).toEqual(expect.arrayContaining([GARDEN_BOT, SLACK_BOT]));
    expect(bots.map((bot) => bot.name).sort()).toEqual(["garden", "notes"]);
  });

  it("gives a bot with two connections two independent views sharing the repo", async () => {
    const bots = await loadBots(twoConnections());

    const garden = bots.filter((bot) => bot.name === "garden");
    expect(garden).toHaveLength(2);
    expect(garden).toEqual(expect.arrayContaining([GARDEN_BOT, GARDEN_SLACK_BOT]));
  });

  it("does not read the flat layout", async () => {
    const bots = await loadBots(fakeParameterStore({ ...PARAMETERS, ...FLAT_PARAMETERS }));

    expect(bots.map((bot) => bot.name)).not.toContain("flat");
  });

  it("skips connections that lack their secrets or a repo binding", async () => {
    const bots = await loadBots(fakeParameterStore());

    expect(bots.map((bot) => bot.name)).not.toContain("partial");
    expect(bots.map((bot) => bot.name)).not.toContain("unbound");
  });

  it("warns once per bot per container, naming only the bot, when it has no connection", async () => {
    const logger = fakeLogger();
    const params = fakeParameterStore({
      ...PARAMETERS,
      ...Object.fromEntries(
        Object.entries(FLAT_PARAMETERS).map(([name, value]) => [
          name.replace("flat", "warned"),
          value,
        ]),
      ),
      [repoParameter("warned-bound")]: "octo/warned",
    });

    await loadBots(params, logger);
    await loadBots(params, logger);
    await loadBot(params, "warned", { logger });

    const warned = logger.warn.mock.calls
      .map(([message]) => message)
      .filter((m) => m.includes("warned"));
    expect(warned).toEqual([
      expect.stringContaining('"warned"'),
      expect.stringContaining('"warned-bound"'),
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("octo/warned");
  });

  it("does not warn for a bot that has a connection", async () => {
    const logger = fakeLogger();

    await loadBots(fakeParameterStore(), logger);

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('"garden"'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('"unbound"'));
  });
});

describe("loadBot", () => {
  it("selects the connection of the requested platform", async () => {
    const params = twoConnections();

    expect(await loadBot(params, "garden", { platform: "slack" })).toEqual(GARDEN_SLACK_BOT);
    expect(await loadBot(params, "garden", { platform: "telegram" })).toEqual(GARDEN_BOT);
  });

  it("takes the only connection when no platform is requested", async () => {
    expect(await loadBot(fakeParameterStore(), "garden")).toEqual(GARDEN_BOT);
  });

  it("selects nothing when no platform is requested and the bot has several connections", async () => {
    expect(await loadBot(twoConnections(), "garden")).toBeUndefined();
  });

  it.each([
    ["a platform it has no connection on", "notes", "telegram"],
    ["a bot with no repo binding", "unbound", "telegram"],
    ["an unknown bot", "nobody", "telegram"],
  ] as const)("returns nothing for %s", async (_name, bot, platform) => {
    expect(await loadBot(fakeParameterStore(), bot, { platform })).toBeUndefined();
  });

  it("does not mix in a similarly named bot", async () => {
    const params = fakeParameterStore({
      ...PARAMETERS,
      ...connectionParameters({ ...GARDEN_BOT, name: "garden-2", token: "other" }, "octo/g2"),
    });

    expect((await loadBot(params, "garden"))?.token).toBe(GARDEN_BOT.token);
  });

  it("ignores access entries stored beside the secrets", async () => {
    const params = fakeParameterStore({
      ...PARAMETERS,
      [approvedParameter("garden", "telegram", "user", "1")]: "{}",
      [tokenParameter("garden", "telegram")]: "rotated",
    });

    expect((await loadBot(params, "garden"))?.token).toBe("rotated");
  });
});

describe("loadBotBinding", () => {
  it("returns the connection's secrets and the bot's repo, bound or not", async () => {
    const params = fakeParameterStore();

    expect(await loadBotBinding(params, "garden")).toEqual({
      secrets: {
        name: "garden",
        platform: "telegram",
        token: "tg-token",
        webhookSecret: "tg-secret",
      },
      repo: "octo/garden",
    });
    expect(await loadBotBinding(params, "unbound")).toMatchObject({ repo: undefined });
    expect((await loadBotBinding(params, "unbound")).secrets).toBeDefined();
  });

  it("returns nothing for a bot with only flat parameters", async () => {
    const params = fakeParameterStore(FLAT_PARAMETERS);

    expect(await loadBotBinding(params, "flat")).toEqual({ secrets: undefined, repo: "octo/flat" });
  });
});
