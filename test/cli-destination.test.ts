import { describe, expect, it } from "vitest";
import { encodeDestination } from "../src/lambda/destinations.js";
import { createCliHarness } from "./helpers/cli.js";
import { TELEGRAM_TOPIC } from "./helpers/destination-fixtures.js";

const SLACK_THREAD = "slack:C0123:1712345.6789";

async function harness(...platforms: ("telegram" | "slack")[]) {
  const cli = createCliHarness();
  for (const platform of platforms) await cli.connect("garden", platform);
  return cli;
}

describe("destination set", () => {
  it.each([
    ["telegram", "-100500", "77", TELEGRAM_TOPIC],
    ["slack", "C0123", "1712345.6789", SLACK_THREAD],
  ] as const)(
    "binds a %s topic to a name, owned by the bot",
    async (platform, chat, topic, thread) => {
      const cli = await harness(platform);
      await cli.approveChat("garden", platform, chat);

      await cli.run("destination", "set", "garden", "weekly", "--chat", chat, "--topic", topic);

      expect(await cli.destinationNamed(platform, "weekly")).toMatchObject({
        chatId: chat,
        threadId: thread,
        bot: "garden",
      });
      expect(cli.output).toEqual([expect.stringContaining(thread)]);
    },
  );

  it.each([
    ["telegram", "-100500"],
    ["slack", "C0123"],
  ] as const)("names a %s chat with no thread", async (platform, chat) => {
    const cli = await harness(platform);
    await cli.approveChat("garden", platform, chat);

    await cli.run("destination", "set", "garden", "household", "--chat", chat);

    const record = await cli.destinationNamed(platform, "household");
    expect(record).toMatchObject({ chatId: chat });
    expect(record).not.toHaveProperty("threadId");
    expect(record).not.toHaveProperty("bot");
  });

  it("replaces a record of the same bot or with no owner, saying what it replaced", async () => {
    const cli = await harness("telegram");
    await cli.approveChat("garden", "telegram", "-100500");
    await cli.store.put("/centaur/chats/telegram/weekly", "-1", { secure: false });
    await cli.run("destination", "set", "garden", "weekly", "--chat", "-100500", "--topic", "77");
    expect(cli.output.at(-1)).toContain("replacing chat -1");

    await cli.run("destination", "set", "garden", "weekly", "--chat", "-100500", "--topic", "88");

    expect((await cli.destinationNamed("telegram", "weekly"))?.threadId).toBe(
      "telegram:-100500:88",
    );
    expect(cli.output.at(-1)).toContain(`replacing ${TELEGRAM_TOPIC}`);
  });

  it("refuses to replace a thread owned by another bot", async () => {
    const cli = await harness("telegram");
    const owned = encodeDestination({ chatId: "-100500", threadId: TELEGRAM_TOPIC, bot: "other" });
    await cli.store.put("/centaur/chats/telegram/weekly", owned, { secure: false });

    await expect(
      cli.run("destination", "set", "garden", "weekly", "--chat", "-100500"),
    ).rejects.toThrow(/owned by bot "other"/);
    expect(await cli.store.get("/centaur/chats/telegram/weekly")).toBe(owned);
  });

  it("warns when the chat is not approved, and still writes the record", async () => {
    const cli = await harness("telegram");

    await cli.run("destination", "set", "garden", "weekly", "--chat", "-100500");

    expect(cli.output[0]).toMatch(/not approved.*centaur access approve garden chat -100500/);
    expect((await cli.destinationNamed("telegram", "weekly"))?.chatId).toBe("-100500");
  });

  it("warns when the chat is blocked", async () => {
    const cli = await harness("telegram");
    await cli.run("access", "block", "garden", "chat", "-100500");

    await cli.run("destination", "set", "garden", "weekly", "--chat", "-100500");

    expect(cli.output.at(-2)).toMatch(/blocked/);
  });

  it("does not warn for an approved chat", async () => {
    const cli = await harness("telegram");
    await cli.approveChat("garden", "telegram", "-100500");

    await cli.run("destination", "set", "garden", "weekly", "--chat", "-100500");

    expect(cli.output).toHaveLength(1);
  });

  it.each([
    [
      ["set", "garden", "weekly", "--chat", "1"],
      /several connections \(telegram, slack\); pass --platform/,
    ],
    [
      ["set", "garden", "weekly", "--chat", "1", "--platform", "mastodon"],
      /Unknown platform "mastodon"/,
    ],
    [["set", "ghost", "weekly", "--chat", "1"], /Unknown bot "ghost"/],
    [
      ["set", "garden", "Bad Name", "--chat", "1", "--platform", "slack"],
      /Invalid destination name/,
    ],
    [["set", "garden", "weekly", "--platform", "slack"], /--chat/],
  ])("rejects destination %j", async (args, message) => {
    const cli = await harness("telegram", "slack");

    await expect(cli.run("destination", ...args)).rejects.toThrow(message);
    expect(cli.store.names().filter((name) => name.startsWith("/centaur/chats/"))).toEqual([]);
  });

  it("rejects a platform the bot has no connection on", async () => {
    const cli = await harness("telegram");

    await expect(
      cli.run("destination", "set", "garden", "weekly", "--chat", "C1", "--platform", "slack"),
    ).rejects.toThrow(/no slack connection/);
  });
});

describe("destination list and remove", () => {
  it("lists both value shapes sorted by name, or says there are none", async () => {
    const cli = await harness("telegram", "slack");
    await cli.run("destination", "list", "garden", "--platform", "telegram");
    expect(cli.output.at(-1)).toMatch(/No destinations/);

    await cli.store.put("/centaur/chats/telegram/workshop", "-2", { secure: false });
    await cli.store.put(
      "/centaur/chats/telegram/weekly",
      encodeDestination({ chatId: "-1", threadId: TELEGRAM_TOPIC, bot: "garden" }),
      { secure: false },
    );
    await cli.store.put("/centaur/chats/slack/other", "C1", { secure: false });
    await cli.store.put("/centaur/chats/legacy", "-9", { secure: false });
    await cli.run("destination", "list", "garden", "--platform", "telegram");

    expect(cli.output.at(-1)).toBe(`weekly  -1  ${TELEGRAM_TOPIC}\nworkshop  -2`);
  });

  it("removes a destination and errors when it is absent", async () => {
    const cli = await harness("telegram");
    await cli.store.put("/centaur/chats/telegram/weekly", "-1", { secure: false });

    await cli.run("destination", "remove", "garden", "weekly");
    expect(cli.output.at(-1)).toMatch(/Removed destination "weekly"/);
    expect(await cli.destinationNamed("telegram", "weekly")).toBeUndefined();

    await expect(cli.run("destination", "remove", "garden", "weekly")).rejects.toThrow(
      /Destination "weekly" not found/,
    );
  });

  it("asks for --platform with several connections", async () => {
    const cli = await harness("telegram", "slack");

    await expect(cli.run("destination", "list", "garden")).rejects.toThrow(/pass --platform/);
  });
});
