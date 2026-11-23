import { describe, expect, it } from "vitest";
import {
  approvedChat,
  GARDEN_REPOSITORY,
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_CHANNEL_ID,
  SLACK_POST_THREAD_ID,
  TOPIC_ID,
} from "./helpers/poster-fixtures.js";
import { GARDEN_SLACK_PARAMETERS } from "./helpers/receiver-fixtures.js";

const TELEGRAM_THREAD = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;
const BOTH_CONNECTIONS = {
  ...GARDEN_SLACK_PARAMETERS,
  "/centaur/chats/garden-channel": SLACK_CHANNEL_ID,
  [approvedChat("garden", SLACK_CHANNEL_ID, "slack")]: "{}",
};
const twoConnections = () =>
  posterSetup({ parameters: BOTH_CONNECTIONS, repository: GARDEN_REPOSITORY });

const GARDEN_TOKENS = { telegram: "tg-token", slack: "xoxb-garden" } as const;

const chatIdOf = (threadId: string) => threadId.split(":")[1] as string;
const READ_OPERATION = { operation: "read", token: "jwt", bot: "garden" } as const;

const threadOperations = (threadId: string) => ({
  post: { operation: "post", bot: "garden", threadId, text: "hi" },
  read: { operation: "read", token: "jwt", bot: "garden", threadId },
  unreact: { operation: "unreact", bot: "garden", threadId, messageIds: ["1"] },
  "read-channel": {
    operation: "read-channel",
    token: "jwt",
    bot: "garden",
    chatId: chatIdOf(threadId),
    threadId,
  },
  "list-threads": {
    operation: "list-threads",
    token: "jwt",
    bot: "garden",
    chatId: chatIdOf(threadId),
    threadId,
  },
  "read-visible": { ...READ_OPERATION, threadId, visibleOnly: true },
});

describe("poster connection selection", () => {
  it.each([
    ["telegram", TELEGRAM_THREAD, "post"],
    ["slack", SLACK_POST_THREAD_ID, "post"],
    ["telegram", TELEGRAM_THREAD, "read"],
    ["slack", SLACK_POST_THREAD_ID, "read"],
    ["telegram", TELEGRAM_THREAD, "unreact"],
    ["slack", SLACK_POST_THREAD_ID, "unreact"],
    ["telegram", TELEGRAM_THREAD, "read-channel"],
    ["telegram", TELEGRAM_THREAD, "list-threads"],
    ["slack", SLACK_POST_THREAD_ID, "read-channel"],
    ["slack", SLACK_POST_THREAD_ID, "list-threads"],
    ["telegram", TELEGRAM_THREAD, "read-visible"],
    ["slack", SLACK_POST_THREAD_ID, "read-visible"],
  ] as const)(
    "opens the %s connection for a %s thread's %s",
    async (platform, threadId, operation) => {
      const { poster, chatFor } = await twoConnections();

      await poster(threadOperations(threadId)[operation]).catch(() => undefined);

      expect(chatFor).toHaveBeenCalled();
      for (const [bot] of chatFor.mock.calls) {
        expect(bot).toMatchObject({ name: "garden", platform, token: GARDEN_TOKENS[platform] });
      }
    },
  );

  it.each(["post", "read", "unreact", "read-channel", "list-threads", "read-visible"] as const)(
    "fails %s for a thread on a platform the bot has no connection on",
    async (operation) => {
      const { poster, chatFor } = await posterSetup({ repository: GARDEN_REPOSITORY });

      await expect(poster(threadOperations(SLACK_POST_THREAD_ID)[operation])).rejects.toThrow(
        'bot "garden" has no connection on platform "slack"',
      );
      expect(chatFor).not.toHaveBeenCalled();
    },
  );

  it("fails a thread ID with no known platform prefix", async () => {
    const { poster } = await twoConnections();

    await expect(poster(threadOperations("matrix:room:1").post)).rejects.toThrow(
      /no known platform prefix/,
    );
  });
});

describe("poster start-thread connection", () => {
  const start = { operation: "start-thread", bot: "garden", text: "x" } as const;

  it("starts a Telegram topic on a two-connection bot when platform names Telegram", async () => {
    const { poster, telegram, chatFor } = await twoConnections();

    await poster({ ...start, destination: "household", platform: "telegram" });

    expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", HOUSEHOLD_CHAT_ID, "x");
    expect(chatFor.mock.calls[0]?.[0]).toMatchObject({ platform: "telegram" });
  });

  it("posts into a Slack channel on a two-connection bot when platform names Slack", async () => {
    const { poster, telegram, channelPost, chatFor } = await twoConnections();

    const result = await poster({ ...start, destination: "garden-channel", platform: "slack" });

    expect(result).toEqual({ threadId: SLACK_POST_THREAD_ID });
    expect(channelPost).toHaveBeenCalledWith("x");
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(chatFor.mock.calls[0]?.[0]).toMatchObject({ platform: "slack", token: "xoxb-garden" });
  });

  it("derives the connection from fromThreadId", async () => {
    const { poster, chatFor } = await twoConnections();

    await poster({ ...start, fromThreadId: TELEGRAM_THREAD });

    expect(chatFor.mock.calls[0]?.[0]).toMatchObject({ platform: "telegram" });
  });

  it("requires platform with a destination when the bot has several connections", async () => {
    const { poster, chatFor } = await twoConnections();

    await expect(poster({ ...start, destination: "household" })).rejects.toThrow(
      'bot "garden" has several connections (telegram, slack); platform is required',
    );
    expect(chatFor).not.toHaveBeenCalled();
  });

  it("takes the only connection without platform", async () => {
    const { poster, chatFor } = await posterSetup();

    await poster({ ...start, destination: "household" });

    expect(chatFor.mock.calls[0]?.[0]).toMatchObject({ platform: "telegram" });
  });

  it("fails a platform the bot has no connection on", async () => {
    const { poster } = await posterSetup();

    await expect(poster({ ...start, destination: "household", platform: "slack" })).rejects.toThrow(
      'bot "garden" has no connection on platform "slack"',
    );
  });

  it.each([
    ["platform with fromThreadId", { fromThreadId: TELEGRAM_THREAD, platform: "telegram" }],
    ["an unknown platform", { destination: "household", platform: "matrix" }],
    ["neither destination nor fromThreadId", { platform: "telegram" }],
  ])("rejects %s", async (_name, fields) => {
    const { poster } = await twoConnections();

    await expect(poster({ ...start, ...fields })).rejects.toThrow();
  });
});
