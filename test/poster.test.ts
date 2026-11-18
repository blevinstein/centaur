import { describe, expect, it } from "vitest";
import { BOT_CREATED_STATE, ownsMessage } from "../src/lambda/ownership.js";
import {
  blockedChat,
  HOUSEHOLD_CHAT_ID,
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

  it("starts the topic in whichever approved chat the destination names", async () => {
    const { poster, telegram } = await posterSetup();

    await poster({ ...START_HOUSEHOLD, destination: "workshop", text: "x" });

    expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", WORKSHOP_CHAT_ID, "x");
  });

  it.each([
    [
      "an unknown alias",
      { destination: "attic" },
      {},
      /unknown chat alias "attic".*centaur access approve garden chat <id> --alias attic/,
    ],
    [
      "an alias whose chat is not approved",
      { destination: "attic" },
      { "/centaur/chats/attic": "-100777" },
      /not approved for bot "garden".*centaur access approve garden chat -100777/,
    ],
    [
      "an alias approved only for another bot",
      { destination: "notes-channel" },
      {},
      /not approved for bot "garden"/,
    ],
    [
      "a blocked chat",
      { destination: "household" },
      { [blockedChat("garden", HOUSEHOLD_CHAT_ID)]: "{}" },
      /chat "household" is blocked/,
    ],
  ])("rejects %s as the destination", async (_name, overrides, parameters, message) => {
    const { poster, telegram } = await posterSetup({ parameters });

    await expect(poster({ ...START_HOUSEHOLD, text: "x", ...overrides })).rejects.toThrow(message);
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });

  describe("from a thread", () => {
    const fromThread = (chatId: string) => ({
      operation: "start-thread" as const,
      bot: "garden",
      text: "fresh",
      fromThreadId: `telegram:${chatId}:5`,
    });

    it.each([
      ["the first approved chat", HOUSEHOLD_CHAT_ID],
      ["another approved chat", WORKSHOP_CHAT_ID],
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

    it("refuses a group chat that is not approved", async () => {
      const { poster, telegram, thread } = await posterSetup();
      Object.assign(thread, { channelId: "telegram:-100777" });

      await expect(poster(fromThread("-100777"))).rejects.toThrow(
        /chat -100777 is not approved.*centaur access approve garden chat -100777/,
      );
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

      await expect(poster(fromThread(HOUSEHOLD_CHAT_ID))).rejects.toThrow(/not approved/);
      expect(telegram.createForumTopic).toHaveBeenCalledExactlyOnceWith(
        "tg-token",
        "-100777",
        "fresh",
      );
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
        attachments: [{ type: "image", mimeType: "image/jpeg" }],
        author: { userId: "1001", userName: "maintainer", isMe: false },
        metadata: { dateSent: new Date("2026-01-02T03:04:05Z") },
      },
      {
        id: "m2",
        text: "hi back",
        attachments: [],
        author: { userId: "bot", userName: "garden", isMe: true },
        metadata: { dateSent: new Date("2026-01-02T03:05:00Z") },
      },
    ];
    const { poster, attachments } = await posterSetup({
      transcript,
      attachments: { m1: ["attachments/garden/t/m1~0.jpg"] },
    });

    const result = await poster({ operation: "read", bot: "garden", threadId: GARDEN_THREAD });

    expect(attachments.forThread).toHaveBeenCalledExactlyOnceWith("garden", GARDEN_THREAD);
    expect(result).toEqual({
      messages: [
        {
          id: "m1",
          userId: "1001",
          userName: "maintainer",
          fromBot: false,
          text: "hello",
          attachments: ["attachments/garden/t/m1~0.jpg"],
          sentAt: "2026-01-02T03:04:05.000Z",
        },
        {
          id: "m2",
          userId: "bot",
          userName: "garden",
          fromBot: true,
          text: "hi back",
          attachments: [],
          sentAt: "2026-01-02T03:05:00.000Z",
        },
      ],
    });
  });
});

describe("poster read of images that were never stored", () => {
  const unstored = {
    id: "m1",
    text: "",
    attachments: [{ type: "image", mimeType: "image/jpeg", fetchMetadata: { fileId: "f" } }],
    author: { userId: "1001", userName: "maintainer", isMe: false },
    metadata: { dateSent: new Date("2026-01-02T03:04:05Z") },
  };
  const read = (poster: Awaited<ReturnType<typeof posterSetup>>["poster"]) =>
    poster({ operation: "read", bot: "garden", threadId: GARDEN_THREAD }) as Promise<{
      messages: { attachments: string[] }[];
    }>;

  it("stores them with a rebuilt downloader and reports their keys", async () => {
    const { poster, attachments, rehydrateAttachment } = await posterSetup({
      transcript: [unstored],
    });
    attachments.save.mockResolvedValueOnce(["attachments/garden/t/m1~0.jpg"]);

    const result = await read(poster);

    expect(rehydrateAttachment).toHaveBeenCalledOnce();
    const saved = attachments.save.mock.calls[0]?.[1];
    expect(await saved?.attachments[0]?.fetchData?.()).toEqual(Buffer.from("bytes"));
    expect(result.messages[0]?.attachments).toEqual(["attachments/garden/t/m1~0.jpg"]);
  });

  it("does not store images again once they have keys", async () => {
    const { poster, attachments } = await posterSetup({
      transcript: [unstored],
      attachments: { m1: ["attachments/garden/t/m1~0.jpg"] },
    });

    const result = await read(poster);

    expect(attachments.save).not.toHaveBeenCalled();
    expect(result.messages[0]?.attachments).toEqual(["attachments/garden/t/m1~0.jpg"]);
  });

  it("still returns the thread when storing an image fails", async () => {
    const { poster, attachments, logger } = await posterSetup({ transcript: [unstored] });
    attachments.save.mockRejectedValueOnce(new Error("telegram down"));

    const result = await read(poster);

    expect(result.messages[0]?.attachments).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
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
