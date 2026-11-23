import { describe, expect, it } from "vitest";
import {
  createDestinationOnFirstUse,
  encodeDestination,
  parseDestination,
  parseDestinations,
  proposeDestinationName,
  recordDestination,
  resolveDestination,
  slugName,
} from "../src/lambda/destinations.js";
import {
  destinationAt,
  GARDEN_CONNECTION,
  TELEGRAM_TOPIC,
} from "./helpers/destination-fixtures.js";
import { fakeParameterStore } from "./helpers/receiver-fixtures.js";

describe("slugName", () => {
  it.each([
    ["Garden Club", "garden-club"],
    ["  --Wöl fs & Co.!  ", "w-l-fs-co"],
    ["Team 42", "team-42"],
    ["A".repeat(60), "a".repeat(40)],
  ])("slugs %j as %j", (title, expected) => {
    expect(slugName(title, "-100500")).toBe(expected);
  });

  it.each([
    ["no title", undefined, "-1001234567890", "chat-7890"],
    ["a title with no latin letters or digits", "家庭", "-100500", "chat-0500"],
    ["a chat ID with no digits", undefined, "general", "chat"],
  ])("falls back to the chat ID for %s", (_name, title, chatId, expected) => {
    expect(slugName(title, chatId)).toBe(expected);
  });
});

describe("destination values", () => {
  it("reads a bare chat ID as a destination with no thread", () => {
    expect(parseDestination("-100500")).toEqual({ chatId: "-100500", at: "unknown" });
  });

  it("reads a record with its thread, owner and policy", () => {
    const value = encodeDestination({
      chatId: "-100500",
      threadId: TELEGRAM_TOPIC,
      bot: "garden",
      context: "transcript",
      name: "Garden Club",
    });

    expect(parseDestination(value)).toMatchObject({
      chatId: "-100500",
      threadId: TELEGRAM_TOPIC,
      bot: "garden",
      context: "transcript",
      name: "Garden Club",
    });
    expect(parseDestination(value).at).toMatch(/^\d{4}-/);
  });

  it("rejects a record with no chat", () => {
    expect(() => parseDestination('{"at":"x"}')).toThrow();
  });

  it("parses every value of a listing, whatever its shape", () => {
    const parsed = parseDestinations({
      "/centaur/chats/telegram/a": "-1",
      "/centaur/chats/telegram/b": encodeDestination({ chatId: "-2" }),
    });

    expect(Object.values(parsed).map((destination) => destination.chatId)).toEqual(["-1", "-2"]);
  });
});

describe("proposeDestinationName", () => {
  const known = parseDestinations({
    "/centaur/chats/telegram/garden-club": "-1",
    "/centaur/chats/telegram/garden-club-2": encodeDestination({ chatId: "-2" }),
    "/centaur/chats/telegram/household": "-100500",
    "/centaur/chats/telegram/weekly": encodeDestination({ chatId: "-7", threadId: TELEGRAM_TOPIC }),
  });

  it("numbers the name past every taken suffix", () => {
    expect(proposeDestinationName(known, "-3", "Garden Club")).toBe("garden-club-3");
  });

  it("returns the name that already holds the chat", () => {
    expect(proposeDestinationName(known, "-100500", "Garden Club")).toBe("household");
  });

  it("does not reuse a destination bound to a thread", () => {
    expect(proposeDestinationName(known, "-7", "Weekly")).toBe("weekly-2");
  });

  it("uses the plain slug when it is free", () => {
    expect(proposeDestinationName({}, "-3", "Garden Club")).toBe("garden-club");
  });
});

describe("recordDestination", () => {
  const fields = { chatId: "-3", name: "Garden Club" };

  it("creates the destination as a record", async () => {
    const params = fakeParameterStore({});

    expect(await recordDestination(params, "telegram", fields, "garden-club")).toBe("garden-club");
    expect(destinationAt(params, "telegram", "garden-club")).toMatchObject(fields);
  });

  it("never replaces a destination for another chat", async () => {
    const params = fakeParameterStore({
      "/centaur/chats/telegram/garden-club": "-1",
      "/centaur/chats/telegram/garden-club-2": "-2",
    });

    expect(await recordDestination(params, "telegram", fields, "garden-club")).toBe(
      "garden-club-3",
    );
    expect(params.values).toMatchObject({
      "/centaur/chats/telegram/garden-club": "-1",
      "/centaur/chats/telegram/garden-club-2": "-2",
    });
    expect(destinationAt(params, "telegram", "garden-club-3").chatId).toBe("-3");
  });

  it("accepts a destination that already holds the chat, in either shape", async () => {
    const params = fakeParameterStore({ "/centaur/chats/telegram/household": "-3" });

    expect(await recordDestination(params, "telegram", fields, "household")).toBe("household");
    expect(params.values["/centaur/chats/telegram/household"]).toBe("-3");
  });

  it("scopes names to the platform", async () => {
    const params = fakeParameterStore({ "/centaur/chats/slack/garden-club": "C1" });

    expect(await recordDestination(params, "telegram", fields, "garden-club")).toBe("garden-club");
    expect(params.values["/centaur/chats/slack/garden-club"]).toBe("C1");
    expect(destinationAt(params, "telegram", "garden-club").chatId).toBe("-3");
  });

  it("gives up after too many conflicts", async () => {
    const params = fakeParameterStore({});
    params.putIfAbsent = async () => false;
    params.get = async () => "-1";

    await expect(recordDestination(params, "telegram", fields, "a")).rejects.toThrow(
      /could not allocate/,
    );
  });
});

describe("resolveDestination", () => {
  const bound = encodeDestination({ chatId: "-100500", threadId: TELEGRAM_TOPIC, bot: "sprout" });

  it("resolves a bare chat ID and a record", async () => {
    const params = fakeParameterStore({
      "/centaur/chats/telegram/household": "-100500",
      "/centaur/chats/telegram/weekly": bound,
    });

    expect(await resolveDestination(params, GARDEN_CONNECTION, "household")).toMatchObject({
      chatId: "-100500",
    });
    expect(
      await resolveDestination(params, { name: "sprout", platform: "telegram" }, "weekly"),
    ).toMatchObject({
      threadId: TELEGRAM_TOPIC,
    });
  });

  it("finds nothing for an unknown name, a flat name or another platform's name", async () => {
    const params = fakeParameterStore({
      "/centaur/chats/attic": "-1",
      "/centaur/chats/slack/attic": "C1",
    });

    expect(await resolveDestination(params, GARDEN_CONNECTION, "attic")).toBeUndefined();
  });

  it("names the owner when another bot resolves a thread-bound destination", async () => {
    const params = fakeParameterStore({ "/centaur/chats/telegram/weekly": bound });

    await expect(resolveDestination(params, GARDEN_CONNECTION, "weekly")).rejects.toThrow(
      'destination "weekly" on telegram is bound to a thread owned by bot "sprout", not "garden"',
    );
  });
});

describe("createDestinationOnFirstUse", () => {
  it("creates the destination in the only approved chat", async () => {
    const params = fakeParameterStore({});

    const created = await createDestinationOnFirstUse(params, GARDEN_CONNECTION, "attic", ["-1"]);

    expect(created.chatId).toBe("-1");
    expect(destinationAt(params, "telegram", "attic")).toEqual(created);
  });

  it("keeps the destination another run created first", async () => {
    const params = fakeParameterStore({ "/centaur/chats/telegram/attic": "-9" });

    const created = await createDestinationOnFirstUse(params, GARDEN_CONNECTION, "attic", ["-1"]);

    expect(created.chatId).toBe("-9");
  });

  it.each([
    [
      "no approved chat",
      [],
      /no approved chat to create it in; approve a chat with `centaur access approve garden chat <id> --platform telegram`, then bind the name with `centaur destination set garden attic --platform telegram --chat <id>`/,
    ],
    [
      "several approved chats",
      ["-1", "-2"],
      /several approved chats, so it cannot choose one; bind the name to a chat with `centaur destination set garden attic --platform telegram --chat <id>`/,
    ],
  ])("fails with %s, naming the command", async (_name, chatIds, message) => {
    const params = fakeParameterStore({});

    await expect(
      createDestinationOnFirstUse(params, GARDEN_CONNECTION, "attic", chatIds),
    ).rejects.toThrow(message);
    expect(params.values).toEqual({});
  });
});
