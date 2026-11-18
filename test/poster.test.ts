import { describe, expect, it } from "vitest";
import { BOT_CREATED_STATE, ownsMessage } from "../src/lambda/ownership.js";
import {
  HOUSEHOLD_CHAT_ID,
  LEGACY_ENTRY,
  posterSetup,
  SLACK_CHANNEL_ID,
  SLACK_POST_THREAD_ID,
  TOPIC_ID,
  WORKSHOP_CHAT_ID,
} from "./helpers/poster-fixtures.js";
import { fakeMessage, fakeThread } from "./helpers/receiver-fixtures.js";

const GARDEN_THREAD = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;
const START_HOUSEHOLD = {
  operation: "start-thread",
  bot: "garden",
  destination: "household",
  text: "x",
} as const;

describe("poster post", () => {
  it("posts text into the thread through the bot's own chat and state prefix", async () => {
    const { poster, chatMock, thread, stateFor } = await posterSetup();

    const result = await poster({
      operation: "post",
      bot: "garden",
      threadId: GARDEN_THREAD,
      text: "hi",
    });

    expect(result).toEqual({ messageId: "sent-1" });
    expect(chatMock.thread).toHaveBeenCalledWith(GARDEN_THREAD);
    expect(thread.post).toHaveBeenCalledWith("hi");
    expect(stateFor).toHaveBeenCalledWith("bot:garden:");
  });

  it.each([
    ["an unknown bot", { bot: "nobody" }],
    ["an unbound bot", { bot: "unbound" }],
    ["a bot with partial secrets", { bot: "partial" }],
  ])("refuses %s", async (_name, overrides) => {
    const { poster, thread } = await posterSetup();

    await expect(
      poster({ operation: "post", threadId: GARDEN_THREAD, text: "hi", ...overrides }),
    ).rejects.toThrow(/unknown or unbound bot/);
    expect(thread.post).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown operation", { operation: "nope" }],
    ["empty text", { operation: "post", bot: "garden", threadId: "t", text: "" }],
    ["extra fields", { operation: "read", bot: "garden", threadId: "t", extra: 1 }],
    ["a non-object", "post"],
  ])("rejects a malformed request: %s", async (_name, request) => {
    const { poster } = await posterSetup();

    await expect(poster(request)).rejects.toThrow();
  });
});

describe("poster start-thread", () => {
  it("creates a Telegram topic in the destination chat, marks it bot-owned, then posts", async () => {
    const { poster, telegram, thread, chatMock, state } = await posterSetup();

    const result = await poster({
      ...START_HOUSEHOLD,
      text: "Saturday tasks\nWater the beds",
      title: "Week 12",
    });

    expect(result).toEqual({ threadId: GARDEN_THREAD });
    expect(telegram.createForumTopic).toHaveBeenCalledWith(
      "tg-token",
      HOUSEHOLD_CHAT_ID,
      "Week 12",
    );
    expect(chatMock.thread).toHaveBeenCalledWith(GARDEN_THREAD);
    expect(thread.setState).toHaveBeenCalledWith(BOT_CREATED_STATE);
    expect(thread.post).toHaveBeenCalledWith("Saturday tasks\nWater the beds");
    expect(thread.setState.mock.invocationCallOrder[0]).toBeLessThan(
      thread.post.mock.invocationCallOrder[0] as number,
    );
    const owned = fakeThread({ state });
    await expect(ownsMessage(owned.thread, fakeMessage(), "mention")).resolves.toBe(true);
  });

  it("names the topic after the first line of the text by default", async () => {
    const { poster, telegram } = await posterSetup();

    await poster({ ...START_HOUSEHOLD, text: "  Saturday tasks\nmore" });

    expect(telegram.createForumTopic).toHaveBeenCalledWith(
      "tg-token",
      HOUSEHOLD_CHAT_ID,
      "Saturday tasks",
    );
  });

  it("starts a Slack thread with a top-level channel post and marks it bot-owned", async () => {
    const { poster, telegram, channelPost, chatMock, thread } = await posterSetup();

    const result = await poster({
      operation: "start-thread",
      bot: "notes",
      destination: "notes-channel",
      text: "Hello",
    });

    expect(result).toEqual({ threadId: SLACK_POST_THREAD_ID });
    expect(chatMock.channel).toHaveBeenCalledWith(`slack:${SLACK_CHANNEL_ID}`);
    expect(channelPost).toHaveBeenCalledWith("Hello");
    expect(chatMock.thread).toHaveBeenCalledWith(SLACK_POST_THREAD_ID);
    expect(thread.setState).toHaveBeenCalledWith(BOT_CREATED_STATE);
    expect(thread.post).not.toHaveBeenCalled();
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });

  it("starts the topic in whichever registered chat the destination names", async () => {
    const { poster, telegram } = await posterSetup();

    await poster({ ...START_HOUSEHOLD, destination: "workshop", text: "x" });

    expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", WORKSHOP_CHAT_ID, "x");
  });

  it.each([
    ["a chat the bot did not register", { destination: "notes-channel" }, undefined],
    [
      "a registered chat missing from SSM",
      { destination: "household" },
      "/centaur/chats/household",
    ],
  ])("rejects %s as the destination", async (_name, overrides, missingParameter) => {
    const { poster, params, telegram } = await posterSetup();
    if (missingParameter) delete params.values[missingParameter];

    await expect(poster({ ...START_HOUSEHOLD, text: "x", ...overrides })).rejects.toThrow();
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });

  it("reads a legacy entry's destination as its only chat", async () => {
    const { poster, registryState, telegram } = await posterSetup();
    await registryState.set("registry:garden", LEGACY_ENTRY);

    await poster({ ...START_HOUSEHOLD, text: "x" });
    await expect(
      poster({ ...START_HOUSEHOLD, destination: "workshop", text: "x" }),
    ).rejects.toThrow(/no registered chat "workshop"/);

    expect(telegram.createForumTopic).toHaveBeenCalledExactlyOnceWith(
      "tg-token",
      HOUSEHOLD_CHAT_ID,
      "x",
    );
  });

  describe("from a thread", () => {
    const fromThread = (chatId: string) => ({
      operation: "start-thread" as const,
      bot: "garden",
      text: "fresh",
      fromThreadId: `telegram:${chatId}:5`,
    });

    it.each([
      ["the first registered chat", HOUSEHOLD_CHAT_ID],
      ["another registered chat", WORKSHOP_CHAT_ID],
    ])("starts the topic in %s", async (_name, chatId) => {
      const { poster, telegram, thread } = await posterSetup();
      Object.assign(thread, { channelId: `telegram:${chatId}` });

      await poster(fromThread(chatId));

      expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", chatId, "fresh");
    });

    it("starts the thread in the DM it came from", async () => {
      const { poster, telegram, thread } = await posterSetup();
      Object.assign(thread, { channelId: "telegram:4242", isDM: true });

      await poster(fromThread("4242"));

      expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", "4242", "fresh");
    });

    it("refuses a group chat the bot did not register", async () => {
      const { poster, telegram, thread } = await posterSetup();
      Object.assign(thread, { channelId: "telegram:-100777" });

      await expect(poster(fromThread("-100777"))).rejects.toThrow(/not registered for chat/);
      expect(telegram.createForumTopic).not.toHaveBeenCalled();
    });

    it("accepts an approved chat and refuses a blocked one", async () => {
      const { poster, telegram, thread } = await posterSetup({
        parameters: {
          "/centaur/bots/garden/approved-chats/-100777": "{}",
          [`/centaur/bots/garden/blocked/chat/${HOUSEHOLD_CHAT_ID}`]: "{}",
        },
      });
      Object.assign(thread, { channelId: "telegram:-100777" });
      await poster(fromThread("-100777"));
      Object.assign(thread, { channelId: `telegram:${HOUSEHOLD_CHAT_ID}` });

      await expect(poster(fromThread(HOUSEHOLD_CHAT_ID))).rejects.toThrow(/not registered/);
      expect(telegram.createForumTopic).toHaveBeenCalledExactlyOnceWith(
        "tg-token",
        "-100777",
        "fresh",
      );
    });

    it("accepts the chat of a legacy entry", async () => {
      const { poster, registryState, telegram } = await posterSetup();
      await registryState.set("registry:garden", LEGACY_ENTRY);

      await poster(fromThread(HOUSEHOLD_CHAT_ID));

      expect(telegram.createForumTopic).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["neither a destination nor a thread", {}],
    ["both a destination and a thread", { destination: "household", fromThreadId: "telegram:1:2" }],
    ["an invalid destination alias", { destination: "Household" }],
  ])("rejects a request with %s", async (_name, target) => {
    const { poster, telegram } = await posterSetup();

    await expect(
      poster({ operation: "start-thread", bot: "garden", text: "x", ...target }),
    ).rejects.toThrow();
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });
});

describe("poster read", () => {
  it("returns the thread transcript oldest first with plain fields", async () => {
    const transcript = [
      {
        id: "m1",
        text: "hello",
        author: { userId: "1001", userName: "maintainer", isMe: false },
        metadata: { dateSent: new Date("2026-01-02T03:04:05Z") },
      },
      {
        id: "m2",
        text: "hi back",
        author: { userId: "bot", userName: "garden", isMe: true },
        metadata: { dateSent: new Date("2026-01-02T03:05:00Z") },
      },
    ];
    const { poster } = await posterSetup({ transcript });

    const result = await poster({ operation: "read", bot: "garden", threadId: GARDEN_THREAD });

    expect(result).toEqual({
      messages: [
        {
          id: "m1",
          userId: "1001",
          userName: "maintainer",
          fromBot: false,
          text: "hello",
          sentAt: "2026-01-02T03:04:05.000Z",
        },
        {
          id: "m2",
          userId: "bot",
          userName: "garden",
          fromBot: true,
          text: "hi back",
          sentAt: "2026-01-02T03:05:00.000Z",
        },
      ],
    });
  });
});

describe("poster unreact", () => {
  it("removes the eyes reaction from each message through the bot's chat", async () => {
    const { poster, removeReaction, thread } = await posterSetup();

    const result = await poster({
      operation: "unreact",
      bot: "garden",
      threadId: GARDEN_THREAD,
      messageIds: ["1", "2"],
    });

    expect(result).toEqual({
      results: [
        { messageId: "1", removed: true },
        { messageId: "2", removed: true },
      ],
    });
    expect(removeReaction).toHaveBeenCalledTimes(2);
    expect(removeReaction).toHaveBeenCalledWith(thread.id, "1", expect.objectContaining({}));
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("logs a failed message by ID and carries on with the rest", async () => {
    const { poster, removeReaction, logger } = await posterSetup();
    removeReaction.mockRejectedValueOnce(new Error("no_reaction"));

    const result = await poster({
      operation: "unreact",
      bot: "garden",
      threadId: GARDEN_THREAD,
      messageIds: ["1", "2"],
    });

    expect(result).toEqual({
      results: [
        { messageId: "1", removed: false },
        { messageId: "2", removed: true },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "failed to remove reaction",
      expect.objectContaining({ bot: "garden", threadId: GARDEN_THREAD, messageId: "1" }),
    );
  });

  it.each([
    ["no messages", { messageIds: [] }],
    ["too many messages", { messageIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) }],
    ["an empty message ID", { messageIds: [""] }],
    ["extra fields", { messageIds: ["1"], text: "hi" }],
    ["an unknown bot", { messageIds: ["1"], bot: "nobody" }],
  ])("rejects %s", async (_name, overrides) => {
    const { poster, removeReaction } = await posterSetup();

    await expect(
      poster({ operation: "unreact", bot: "garden", threadId: GARDEN_THREAD, ...overrides }),
    ).rejects.toThrow();
    expect(removeReaction).not.toHaveBeenCalled();
  });
});
