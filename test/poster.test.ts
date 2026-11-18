import { describe, expect, it } from "vitest";
import { BOT_CREATED_STATE, ownsMessage } from "../src/lambda/ownership.js";
import {
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_CHANNEL_ID,
  SLACK_POST_THREAD_ID,
  TOPIC_ID,
} from "./helpers/poster-fixtures.js";
import { fakeMessage, fakeThread } from "./helpers/receiver-fixtures.js";

const GARDEN_THREAD = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;

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
      operation: "start-thread",
      bot: "garden",
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
    await expect(ownsMessage(owned.thread, fakeMessage())).resolves.toBe(true);
  });

  it("names the topic after the first line of the text by default", async () => {
    const { poster, telegram } = await posterSetup();

    await poster({ operation: "start-thread", bot: "garden", text: "  Saturday tasks\nmore" });

    expect(telegram.createForumTopic).toHaveBeenCalledWith(
      "tg-token",
      HOUSEHOLD_CHAT_ID,
      "Saturday tasks",
    );
  });

  it("starts a Slack thread with a top-level channel post and marks it bot-owned", async () => {
    const { poster, telegram, channelPost, chatMock, thread } = await posterSetup();

    const result = await poster({ operation: "start-thread", bot: "notes", text: "Hello" });

    expect(result).toEqual({ threadId: SLACK_POST_THREAD_ID });
    expect(chatMock.channel).toHaveBeenCalledWith(`slack:${SLACK_CHANNEL_ID}`);
    expect(channelPost).toHaveBeenCalledWith("Hello");
    expect(chatMock.thread).toHaveBeenCalledWith(SLACK_POST_THREAD_ID);
    expect(thread.setState).toHaveBeenCalledWith(BOT_CREATED_STATE);
    expect(thread.post).not.toHaveBeenCalled();
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });

  it("fails without a registered destination", async () => {
    const { poster, registryState, telegram } = await posterSetup();
    await registryState.set("registry:garden", { allow: ["maintainer"] });

    await expect(poster({ operation: "start-thread", bot: "garden", text: "x" })).rejects.toThrow(
      /no registered destination/,
    );
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
