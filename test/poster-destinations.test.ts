import { describe, expect, it } from "vitest";
import {
  boundWeekly,
  destinationAt,
  destinationPoster,
  GARDEN_SLACK_CHANNEL_PARAMETERS,
  NOT_A_FORUM_ERROR,
  RECREATED_TOPIC,
  RECREATED_TOPIC_ID,
  START_WEEKLY,
  START_WEEKLY_PERSISTENT,
  soloBotParameters,
  TELEGRAM_TOPIC,
  TOPIC_CLOSED_ERROR,
  TOPIC_GONE_ERROR,
  WEEKLY_PARAMETER,
} from "./helpers/destination-fixtures.js";
import { HOUSEHOLD_CHAT_ID, SLACK_CHANNEL_ID, TOPIC_ID } from "./helpers/poster-fixtures.js";

const START_SOLO = { ...START_WEEKLY, bot: "solo", destination: "attic" } as const;

describe("start-thread destination values", () => {
  it.each([
    ["a bare chat ID", HOUSEHOLD_CHAT_ID],
    ["a record", boundWeekly({ threadId: undefined })],
  ])("starts a topic in the chat of %s", async (_name, weekly) => {
    const { poster, telegram } = await destinationPoster({ weekly });

    const result = await poster(START_WEEKLY);

    expect(result).toEqual({ threadId: TELEGRAM_TOPIC });
    expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", HOUSEHOLD_CHAT_ID, "x");
  });

  it("names the owner when another bot's thread is bound to the destination", async () => {
    const { poster, telegram } = await destinationPoster({
      weekly: boundWeekly({ bot: "sprout" }),
    });

    await expect(poster(START_WEEKLY)).rejects.toThrow(
      'destination "weekly" on telegram is bound to a thread owned by bot "sprout", not "garden"',
    );
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });
});

describe("create on first use", () => {
  it("creates a thread-less destination in the only approved chat for a new thread", async () => {
    const { poster, telegram, params } = await destinationPoster({
      parameters: soloBotParameters(),
    });

    await poster(START_SOLO);

    expect(telegram.createForumTopic).toHaveBeenCalledWith("solo-token", HOUSEHOLD_CHAT_ID, "x");
    expect(destinationAt(params, "telegram", "attic")).toMatchObject({ chatId: HOUSEHOLD_CHAT_ID });
    expect(destinationAt(params, "telegram", "attic").threadId).toBeUndefined();
  });

  it("creates the destination and binds a created thread for a persistent prompt", async () => {
    const { poster, params, threadMetaOf } = await destinationPoster({
      parameters: soloBotParameters(),
    });

    const result = await poster({ ...START_SOLO, thread: "persistent", context: "transcript" });

    expect(result).toEqual({ threadId: TELEGRAM_TOPIC });
    expect(destinationAt(params, "telegram", "attic")).toMatchObject({
      chatId: HOUSEHOLD_CHAT_ID,
      threadId: TELEGRAM_TOPIC,
      bot: "solo",
      context: "transcript",
    });
    expect(await threadMetaOf("solo").read(TELEGRAM_TOPIC)).toMatchObject({
      destination: "attic",
      context: "transcript",
    });
  });

  it.each([
    ["no approved chat", [], /no approved chat to create it in/],
    ["several approved chats", ["-1", "-2"], /several approved chats, so it cannot choose one/],
  ])("fails with %s and creates nothing", async (_name, chatIds, message) => {
    const { poster, telegram, params } = await destinationPoster({
      parameters: soloBotParameters(chatIds),
    });

    await expect(poster(START_SOLO)).rejects.toThrow(message);
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(params.values["/centaur/chats/telegram/attic"]).toBeUndefined();
  });
});

describe("thread: new", () => {
  it.each([
    ["by default", {}],
    ["when asked for", { thread: "new" }],
  ] as const)("ignores and keeps the bound thread %s", async (_name, overrides) => {
    const bound = boundWeekly({ context: "transcript" });
    const { poster, telegram, thread, params } = await destinationPoster({ weekly: bound });
    telegram.createForumTopic.mockResolvedValueOnce(RECREATED_TOPIC_ID);

    const result = await poster({ ...START_WEEKLY, ...overrides });

    expect(result).toEqual({ threadId: RECREATED_TOPIC });
    expect(thread.post).toHaveBeenCalledOnce();
    expect(telegram.createForumTopic).toHaveBeenCalledOnce();
    expect(params.values[WEEKLY_PARAMETER]).toBe(bound);
  });
});

describe("thread: persistent", () => {
  it("posts into the bound thread without creating a topic, refreshing its metadata", async () => {
    const { poster, telegram, thread, threadMetaOf, weekly } = await destinationPoster({
      weekly: boundWeekly({ context: "fresh" }),
    });

    const result = await poster({ ...START_WEEKLY_PERSISTENT, context: "transcript" });

    expect(result).toEqual({ threadId: TELEGRAM_TOPIC });
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledWith("x");
    expect(await threadMetaOf("garden").read(TELEGRAM_TOPIC)).toMatchObject({
      destination: "weekly",
      context: "transcript",
    });
    expect(weekly()).toMatchObject({ threadId: TELEGRAM_TOPIC, context: "transcript" });
  });

  it("creates a topic in the record's chat and binds it when the record has none", async () => {
    const { poster, telegram, weekly } = await destinationPoster({ weekly: HOUSEHOLD_CHAT_ID });

    const result = await poster({ ...START_WEEKLY_PERSISTENT, context: "resume" });

    expect(result).toEqual({ threadId: TELEGRAM_TOPIC });
    expect(telegram.createForumTopic).toHaveBeenCalledWith("tg-token", HOUSEHOLD_CHAT_ID, "x");
    expect(weekly()).toMatchObject({
      chatId: HOUSEHOLD_CHAT_ID,
      threadId: TELEGRAM_TOPIC,
      bot: "garden",
      context: "resume",
    });
  });

  it("recreates a deleted topic, updates the record and posts there", async () => {
    const { poster, telegram, thread, weekly, threadMetaOf } = await destinationPoster({
      weekly: boundWeekly(),
    });
    thread.post.mockRejectedValueOnce(new Error(TOPIC_GONE_ERROR));
    telegram.createForumTopic.mockResolvedValueOnce(RECREATED_TOPIC_ID);

    const result = await poster(START_WEEKLY_PERSISTENT);

    expect(result).toEqual({ threadId: RECREATED_TOPIC });
    expect(telegram.reopenForumTopic).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(2);
    expect(weekly().threadId).toBe(RECREATED_TOPIC);
    expect(await threadMetaOf("garden").read(RECREATED_TOPIC)).toMatchObject({
      destination: "weekly",
    });
  });

  it("reopens a closed topic and keeps the binding", async () => {
    const { poster, telegram, thread, weekly } = await destinationPoster({ weekly: boundWeekly() });
    thread.post.mockRejectedValueOnce(new Error(TOPIC_CLOSED_ERROR));

    const result = await poster(START_WEEKLY_PERSISTENT);

    expect(result).toEqual({ threadId: TELEGRAM_TOPIC });
    expect(telegram.reopenForumTopic).toHaveBeenCalledExactlyOnceWith(
      "tg-token",
      HOUSEHOLD_CHAT_ID,
      TOPIC_ID,
    );
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(weekly().threadId).toBe(TELEGRAM_TOPIC);
  });

  it("recreates a closed topic that cannot be reopened", async () => {
    const { poster, telegram, thread, weekly } = await destinationPoster({ weekly: boundWeekly() });
    thread.post.mockRejectedValueOnce(new Error(TOPIC_CLOSED_ERROR));
    telegram.reopenForumTopic.mockRejectedValueOnce(new Error("not enough rights"));
    telegram.createForumTopic.mockResolvedValueOnce(RECREATED_TOPIC_ID);

    const result = await poster(START_WEEKLY_PERSISTENT);

    expect(result).toEqual({ threadId: RECREATED_TOPIC });
    expect(weekly().threadId).toBe(RECREATED_TOPIC);
  });

  it("fails on any other posting error and leaves the record alone", async () => {
    const bound = boundWeekly();
    const { poster, telegram, thread, params } = await destinationPoster({ weekly: bound });
    thread.post.mockRejectedValueOnce(new Error("Telegram is down"));

    await expect(poster(START_WEEKLY_PERSISTENT)).rejects.toThrow("Telegram is down");
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(params.values[WEEKLY_PARAMETER]).toBe(bound);
  });

  it("names the destination when its chat is not a forum, binding nothing", async () => {
    const { poster, telegram, params } = await destinationPoster({ weekly: HOUSEHOLD_CHAT_ID });
    telegram.createForumTopic.mockRejectedValueOnce(new Error(NOT_A_FORUM_ERROR));

    await expect(poster(START_WEEKLY_PERSISTENT)).rejects.toThrow(
      'destination "weekly" is a chat without forum topics, so it cannot hold a thread',
    );
    expect(params.values[WEEKLY_PARAMETER]).toBe(HOUSEHOLD_CHAT_ID);
  });

  it("is not supported on Slack yet", async () => {
    const { poster, channelPost } = await destinationPoster();

    await expect(
      poster({
        operation: "start-thread",
        bot: "notes",
        destination: "notes-channel",
        text: "x",
        thread: "persistent",
      }),
    ).rejects.toThrow("a persistent thread is not supported on slack yet");
    expect(channelPost).not.toHaveBeenCalled();
  });

  it("refuses a destination whose bound thread another bot owns", async () => {
    const { poster, thread } = await destinationPoster({ weekly: boundWeekly({ bot: "sprout" }) });

    await expect(poster(START_WEEKLY_PERSISTENT)).rejects.toThrow(/owned by bot "sprout"/);
    expect(thread.post).not.toHaveBeenCalled();
  });
});

describe("start-thread thread field", () => {
  it.each([
    ["an unknown thread mode", { ...START_WEEKLY, thread: "forever" }],
    [
      "thread with fromThreadId",
      {
        operation: "start-thread",
        bot: "garden",
        text: "x",
        fromThreadId: TELEGRAM_TOPIC,
        thread: "new",
      },
    ],
  ])("rejects %s", async (_name, request) => {
    const { poster, telegram } = await destinationPoster();

    await expect(poster(request)).rejects.toThrow();
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });
});

describe("resolve-destination", () => {
  const resolve = (overrides: object = {}) => ({
    operation: "resolve-destination",
    token: "jwt",
    bot: "garden",
    name: "weekly",
    ...overrides,
  });

  it("returns the chat of a destination without creating anything", async () => {
    const { poster, telegram, params } = await destinationPoster({ weekly: boundWeekly() });

    expect(await poster(resolve())).toEqual({ chatId: HOUSEHOLD_CHAT_ID });
    expect(await poster(resolve({ thread: "new" }))).toEqual({ chatId: HOUSEHOLD_CHAT_ID });
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    expect(Object.keys(params.values)).not.toContain("/centaur/chats/telegram/attic");
  });

  it("returns the bound thread for a persistent prompt", async () => {
    const { poster } = await destinationPoster({ weekly: boundWeekly() });

    expect(await poster(resolve({ thread: "persistent" }))).toEqual({
      chatId: HOUSEHOLD_CHAT_ID,
      threadId: TELEGRAM_TOPIC,
    });
  });

  it("reads a bare chat ID", async () => {
    const { poster } = await destinationPoster({ weekly: HOUSEHOLD_CHAT_ID });

    expect(await poster(resolve({ thread: "persistent" }))).toEqual({ chatId: HOUSEHOLD_CHAT_ID });
  });

  it("reports an unknown name instead of creating it", async () => {
    const { poster, params } = await destinationPoster({ parameters: soloBotParameters() });

    expect(await poster(resolve({ bot: "solo", name: "attic" }))).toEqual({ found: false });
    expect(params.values["/centaur/chats/telegram/attic"]).toBeUndefined();
  });

  it("selects the connection with platform", async () => {
    const { poster } = await destinationPoster({ parameters: GARDEN_SLACK_CHANNEL_PARAMETERS });

    expect(await poster(resolve({ name: "garden-channel", platform: "slack" }))).toEqual({
      chatId: SLACK_CHANNEL_ID,
    });
  });

  it.each([
    [
      "a destination another bot's thread is bound to",
      { weekly: boundWeekly({ bot: "sprout" }) },
      /owned by bot "sprout"/,
    ],
    ["a chat that is not approved", { weekly: "-100777" }, /not approved for bot "garden"/],
  ])("refuses %s", async (_name, options, message) => {
    const { poster } = await destinationPoster(options);

    await expect(poster(resolve())).rejects.toThrow(message);
  });

  it("requires the bot to be bound to the calling repository", async () => {
    const { poster, oidc } = await destinationPoster({ weekly: HOUSEHOLD_CHAT_ID });
    oidc.verify.mockResolvedValueOnce({ repository: "octo/other" });

    await expect(poster(resolve())).rejects.toThrow('bot "garden" is not bound to octo/other');
  });

  it.each([
    ["an extra key", { repository: "octo/other" }],
    ["an invalid name", { name: "Weekly" }],
    ["an unknown thread mode", { thread: "forever" }],
    ["no token", { token: undefined }],
  ])("rejects a request with %s", async (_name, overrides) => {
    const { poster } = await destinationPoster({ weekly: HOUSEHOLD_CHAT_ID });

    await expect(poster(resolve(overrides))).rejects.toThrow();
  });
});
