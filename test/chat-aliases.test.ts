import { describe, expect, it } from "vitest";
import { proposeChatAlias, recordChatAlias, slugAlias } from "../src/lambda/chat-aliases.js";
import { fakeParameterStore } from "./helpers/receiver-fixtures.js";

describe("slugAlias", () => {
  it.each([
    ["Garden Club", "garden-club"],
    ["  --Wöl fs & Co.!  ", "w-l-fs-co"],
    ["Team 42", "team-42"],
    ["A".repeat(60), "a".repeat(40)],
  ])("slugs %j as %j", (title, expected) => {
    expect(slugAlias(title, "-100500")).toBe(expected);
  });

  it.each([
    ["no title", undefined, "-1001234567890", "chat-7890"],
    ["a title with no latin letters or digits", "家庭", "-100500", "chat-0500"],
    ["a chat ID with no digits", undefined, "general", "chat"],
  ])("falls back to the chat ID for %s", (_name, title, chatId, expected) => {
    expect(slugAlias(title, chatId)).toBe(expected);
  });
});

describe("proposeChatAlias", () => {
  const known = {
    "/centaur/chats/garden-club": "-1",
    "/centaur/chats/garden-club-2": "-2",
    "/centaur/chats/household": "-100500",
  };

  it("numbers the alias past every taken suffix", () => {
    expect(proposeChatAlias(known, "-3", "Garden Club")).toBe("garden-club-3");
  });

  it("returns the alias that already names the chat", () => {
    expect(proposeChatAlias(known, "-100500", "Garden Club")).toBe("household");
  });

  it("uses the plain slug when it is free", () => {
    expect(proposeChatAlias({}, "-3", "Garden Club")).toBe("garden-club");
  });
});

describe("recordChatAlias", () => {
  it("creates the alias", async () => {
    const params = fakeParameterStore({});

    expect(await recordChatAlias(params, "-3", "garden-club")).toBe("garden-club");
    expect(params.values["/centaur/chats/garden-club"]).toBe("-3");
  });

  it("never replaces an alias for another chat", async () => {
    const params = fakeParameterStore({
      "/centaur/chats/garden-club": "-1",
      "/centaur/chats/garden-club-2": "-2",
    });

    expect(await recordChatAlias(params, "-3", "garden-club")).toBe("garden-club-3");
    expect(params.values).toMatchObject({
      "/centaur/chats/garden-club": "-1",
      "/centaur/chats/garden-club-2": "-2",
      "/centaur/chats/garden-club-3": "-3",
    });
  });

  it("accepts an alias that already names the chat", async () => {
    const params = fakeParameterStore({ "/centaur/chats/household": "-3" });

    expect(await recordChatAlias(params, "-3", "household")).toBe("household");
    expect(Object.keys(params.values)).toEqual(["/centaur/chats/household"]);
  });

  it("gives up after too many conflicts", async () => {
    const params = fakeParameterStore({});
    params.putIfAbsent = async () => false;
    params.get = async () => "-1";

    await expect(recordChatAlias(params, "-3", "a")).rejects.toThrow(/could not allocate/);
  });
});
