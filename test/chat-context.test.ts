import { describe, expect, it } from "vitest";
import {
  LIST_THREADS_MAX,
  MESSAGE_TEXT_MAX,
  PARTICIPANTS_MAX,
  READ_CHANNEL_DEFAULT,
  READ_CHANNEL_MAX,
  SNIPPET_MAX,
} from "../src/lambda/chat-context.js";
import {
  contextMessage,
  contextSetup,
  ENROLLED_USER,
  GARDEN_THREAD,
  listedThread,
  OTHER_BOT_USER,
  SLACK_TARGET,
  SLACK_THREAD,
  STRANGER,
  scannedRange,
  TELEGRAM_TARGET,
} from "./helpers/chat-context-fixtures.js";
import { blockedChat, HOUSEHOLD_CHAT_ID, WORKSHOP_CHAT_ID } from "./helpers/poster-fixtures.js";

const LIST = { operation: "list-threads", ...TELEGRAM_TARGET } as const;
const READ = { operation: "read-channel", ...TELEGRAM_TARGET } as const;
const SLACK_LIST = { operation: "list-threads", ...SLACK_TARGET } as const;
const SLACK_READ = { operation: "read-channel", ...SLACK_TARGET } as const;
const TOPIC_A = "telegram:-100500:1";
const TOPIC_B = "telegram:-100500:2";

describe("chat context authorization", () => {
  it.each([
    ["list-threads", LIST],
    ["read-channel", READ],
  ])("%s refuses a bot bound to a different repository", async (_name, request) => {
    const { poster, chatMock } = await contextSetup({ repository: "octo/other" });

    await expect(poster(request)).rejects.toThrow(/not bound to octo\/other/);
    expect(chatMock.channel).not.toHaveBeenCalled();
  });

  it.each([
    ["list-threads", LIST],
    ["read-channel", READ],
  ])("%s refuses a chat that is not approved", async (_name, request) => {
    const { poster } = await contextSetup();

    await expect(poster({ ...request, chatId: "-100777" })).rejects.toThrow(
      /chat -100777 is not approved for bot "garden"/,
    );
  });

  it.each([
    ["list-threads", LIST],
    ["read-channel", READ],
  ])("%s refuses a blocked chat", async (_name, request) => {
    const { poster } = await contextSetup({
      parameters: { [blockedChat("garden", HOUSEHOLD_CHAT_ID)]: "{}" },
    });

    await expect(poster(request)).rejects.toThrow(/is blocked/);
  });

  it.each([
    ["list-threads", LIST],
    ["read-channel", READ],
  ])("%s refuses an approved chat other than the dispatched thread's", async (_name, request) => {
    const { poster } = await contextSetup();

    await expect(poster({ ...request, chatId: WORKSHOP_CHAT_ID })).rejects.toThrow(
      /not the chat of the dispatched thread/,
    );
  });

  it.each([
    ["an extra field", { repository: "octo/garden" }],
    ["a missing token", { token: undefined }],
    ["a missing dispatched thread", { threadId: undefined }],
    ["a limit past the maximum", { limit: LIST_THREADS_MAX + 1 }],
    ["a zero limit", { limit: 0 }],
  ])("list-threads rejects %s", async (_name, override) => {
    const { poster } = await contextSetup();

    await expect(poster({ ...LIST, ...override })).rejects.toThrow();
  });

  it.each([
    ["a limit past the maximum", { limit: READ_CHANNEL_MAX + 1 }],
    ["a malformed before", { before: "yesterday" }],
  ])("read-channel rejects %s", async (_name, override) => {
    const { poster } = await contextSetup();

    await expect(poster({ ...READ, ...override })).rejects.toThrow();
  });
});

describe("telegram list-threads", () => {
  it("groups stored history by topic, newest topic first, with the enrolled participants", async () => {
    const { poster } = await contextSetup({
      history: [
        contextMessage({
          id: "5",
          threadId: TOPIC_B,
          text: "latest B",
          userName: "sam",
          minute: 9,
        }),
        contextMessage({ id: "4", threadId: TOPIC_A, text: "latest A", minute: 7 }),
        contextMessage({
          id: "3",
          threadId: TOPIC_B,
          text: "start of B\nmore",
          userName: "pat",
          minute: 5,
        }),
        contextMessage({ id: "2", threadId: TOPIC_A, text: "reply", userName: "pat", minute: 3 }),
        contextMessage({
          id: "1",
          threadId: TOPIC_A,
          text: "start of A",
          userName: "pat",
          minute: 1,
        }),
      ],
      parameters: { "/centaur/bots/garden/approved-users/2002": "{}" },
    });

    expect(await poster(LIST)).toEqual({
      threads: [
        {
          threadId: TOPIC_B,
          title: "start of B",
          lastActivity: "2026-01-02T03:09:00.000Z",
          messageCount: 2,
          participants: ["sam", "pat"],
          snippet: "latest B",
        },
        {
          threadId: TOPIC_A,
          title: "start of A",
          lastActivity: "2026-01-02T03:07:00.000Z",
          messageCount: 3,
          participants: ["pat"],
          snippet: "latest A",
        },
      ],
      scanned: scannedRange(1, true),
    });
  });

  it("drops senders who are not enrolled and other bots, but keeps the bot's own messages", async () => {
    const { poster } = await contextSetup({
      history: [
        contextMessage({
          id: "4",
          text: "from the bot",
          userId: "bot",
          userName: "garden",
          isMe: true,
          minute: 4,
        }),
        contextMessage({
          id: "3",
          text: "other bot",
          userId: OTHER_BOT_USER,
          isBot: true,
          minute: 3,
        }),
        contextMessage({ id: "2", text: "stranger", userId: STRANGER, userName: "eve", minute: 2 }),
        contextMessage({ id: "1", text: "enrolled", minute: 1 }),
      ],
    });

    const { threads } = (await poster(LIST)) as {
      threads: { messageCount: number; participants: string[] }[];
    };

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ messageCount: 2, participants: ["garden", "pat"] });
  });

  it("returns only the requested number of threads and clips titles, snippets and participants", async () => {
    const { poster } = await contextSetup({
      history: [
        contextMessage({
          id: "3",
          threadId: TOPIC_A,
          text: "x".repeat(SNIPPET_MAX * 2),
          minute: 3,
        }),
        ...Array.from({ length: PARTICIPANTS_MAX + 2 }, (_, index) =>
          contextMessage({
            id: `p${index}`,
            threadId: TOPIC_B,
            userName: `user${index}`,
            minute: 2,
          }),
        ),
      ],
    });

    const { threads } = (await poster({ ...LIST, limit: 1 })) as {
      threads: { snippet: string }[];
    };
    const both = (await poster(LIST)) as { threads: { participants: string[] }[] };

    expect(threads).toHaveLength(1);
    expect(threads[0]?.snippet).toHaveLength(SNIPPET_MAX);
    expect(both.threads[1]?.participants).toHaveLength(PARTICIPANTS_MAX);
  });
});

describe("telegram read-channel", () => {
  it("returns visible messages newest first in the read shape plus the thread", async () => {
    const { poster } = await contextSetup({
      history: [
        contextMessage({ id: "3", threadId: TOPIC_B, minute: 3 }),
        contextMessage({ id: "2", userId: STRANGER, minute: 2 }),
        contextMessage({ id: "1", threadId: TOPIC_A, userName: "sam", minute: 1 }),
      ],
    });

    expect(await poster(READ)).toEqual({
      messages: [
        {
          id: "3",
          threadId: TOPIC_B,
          userId: ENROLLED_USER,
          userName: "pat",
          fromBot: false,
          text: "text of 3",
          attachments: [],
          sentAt: "2026-01-02T03:03:00.000Z",
        },
        {
          id: "1",
          threadId: TOPIC_A,
          userId: ENROLLED_USER,
          userName: "sam",
          fromBot: false,
          text: "text of 1",
          attachments: [],
          sentAt: "2026-01-02T03:01:00.000Z",
        },
      ],
      scanned: scannedRange(1, true),
    });
  });

  it("caps the count, defaults the limit and clips message text", async () => {
    const history = Array.from({ length: READ_CHANNEL_DEFAULT + 5 }, (_, index) =>
      contextMessage({
        id: `m${index}`,
        text: "y".repeat(MESSAGE_TEXT_MAX + 10),
        minute: 59 - (index % 60),
      }),
    );
    const { poster } = await contextSetup({ history });

    const defaulted = (await poster(READ)) as { messages: { text: string }[] };
    const limited = (await poster({ ...READ, limit: 2 })) as { messages: unknown[] };

    expect(defaulted.messages).toHaveLength(READ_CHANNEL_DEFAULT);
    expect(defaulted.messages[0]?.text).toHaveLength(MESSAGE_TEXT_MAX);
    expect(limited.messages).toHaveLength(2);
  });

  it("pages backwards with before", async () => {
    const { poster } = await contextSetup({
      history: [
        contextMessage({ id: "3", minute: 3 }),
        contextMessage({ id: "2", minute: 2 }),
        contextMessage({ id: "1", minute: 1 }),
      ],
    });

    const result = (await poster({ ...READ, before: "2026-01-02T03:03:00.000Z" })) as {
      messages: { id: string }[];
    };

    expect(result.messages.map((message) => message.id)).toEqual(["2", "1"]);
  });
});

describe("slack list-threads", () => {
  it("maps the adapter's thread listing and drops other bots and unenrolled senders", async () => {
    const { poster, listThreads } = await contextSetup({
      platform: "slack",
      threads: [
        listedThread({
          id: "a",
          threadId: SLACK_THREAD,
          text: "Plan the week\ndetails",
          replyCount: 4,
          lastReplyMinute: 30,
        }),
        listedThread({ id: "b", threadId: "slack:C0123:2", userId: OTHER_BOT_USER, isBot: true }),
        listedThread({ id: "c", threadId: "slack:C0123:3", userId: STRANGER }),
      ],
    });

    expect(await poster({ ...SLACK_LIST, limit: 5 })).toEqual({
      threads: [
        {
          threadId: SLACK_THREAD,
          title: "Plan the week",
          lastActivity: "2026-01-02T03:30:00.000Z",
          messageCount: 5,
          participants: ["pat"],
          snippet: "Plan the week\ndetails",
        },
      ],
      scanned: scannedRange(0, true),
    });
    expect(listThreads).toHaveBeenCalledExactlyOnceWith("slack:C0123", { limit: 5 });
  });

  it("keeps other bots' threads when the caller opts in", async () => {
    const { poster } = await contextSetup({
      platform: "slack",
      threads: [listedThread({ userId: OTHER_BOT_USER, isBot: true, userName: "deploybot" })],
    });

    const { threads } = (await poster({ ...SLACK_LIST, includeBots: true })) as {
      threads: { participants: string[] }[];
    };

    expect(threads[0]?.participants).toEqual(["deploybot"]);
  });
});

describe("slack read-channel", () => {
  it("returns the adapter's top-level messages newest first with the sender filter applied", async () => {
    const { poster, fetchChannelMessages } = await contextSetup({
      platform: "slack",
      channelPage: [
        contextMessage({ id: "1", threadId: SLACK_THREAD, minute: 1 }),
        contextMessage({
          id: "2",
          threadId: SLACK_THREAD,
          userId: OTHER_BOT_USER,
          isBot: true,
          minute: 2,
        }),
        contextMessage({ id: "3", threadId: SLACK_THREAD, userId: STRANGER, minute: 3 }),
        contextMessage({ id: "4", threadId: SLACK_THREAD, minute: 4 }),
      ],
    });

    const result = (await poster({ ...SLACK_READ, limit: 10 })) as { messages: { id: string }[] };

    expect(result.messages.map((message) => message.id)).toEqual(["4", "1"]);
    expect(fetchChannelMessages).toHaveBeenCalledExactlyOnceWith("slack:C0123", {
      limit: 10,
      direction: "backward",
    });
  });

  it("includes other bots' messages only when asked and pages with a Slack timestamp cursor", async () => {
    const { poster, fetchChannelMessages } = await contextSetup({
      platform: "slack",
      channelPage: [contextMessage({ id: "2", userId: OTHER_BOT_USER, isBot: true })],
    });

    const result = (await poster({
      ...SLACK_READ,
      includeBots: true,
      before: "2026-01-02T03:04:05.000Z",
    })) as { messages: unknown[] };

    expect(result.messages).toHaveLength(1);
    expect(fetchChannelMessages).toHaveBeenCalledWith("slack:C0123", {
      limit: READ_CHANNEL_DEFAULT,
      direction: "backward",
      cursor: "1767323045.000000",
    });
  });
});

describe("scanned range", () => {
  const history = () => [
    contextMessage({ id: "3", minute: 3 }),
    contextMessage({ id: "2", userId: STRANGER, minute: 2 }),
    contextMessage({ id: "1", minute: 1 }),
  ];

  it("is empty and exhausted when there is no history", async () => {
    const { poster } = await contextSetup();

    expect(await poster(READ)).toEqual({ messages: [], scanned: scannedRange(null, true) });
    expect(await poster(LIST)).toEqual({ threads: [], scanned: scannedRange(null, true) });
  });

  it("counts messages from unenrolled senders as examined", async () => {
    const { poster } = await contextSetup({
      history: [contextMessage({ id: "2", userId: STRANGER, minute: 2 })],
    });

    expect(await poster(READ)).toEqual({ messages: [], scanned: scannedRange(2, true) });
  });

  it("is not exhausted when the limit stops a telegram read early", async () => {
    const { poster } = await contextSetup({ history: history() });

    expect(await poster({ ...READ, limit: 1 })).toMatchObject({ scanned: scannedRange(3, false) });
  });

  it("is not exhausted when Slack reports older pages", async () => {
    const { poster } = await contextSetup({
      platform: "slack",
      nextCursor: "older",
      channelPage: [contextMessage({ id: "1", minute: 7 })],
      threads: [listedThread({ minute: 9 })],
    });

    expect(await poster(SLACK_READ)).toMatchObject({ scanned: scannedRange(7, false) });
    expect(await poster(SLACK_LIST)).toMatchObject({ scanned: scannedRange(9, false) });
  });
});

describe("chat context failures", () => {
  it("logs the bot, chat and count but never the content, then rethrows", async () => {
    const { poster, logger, fetchChannelMessages } = await contextSetup({ platform: "slack" });
    fetchChannelMessages.mockRejectedValueOnce(new Error("secret message text"));

    await expect(poster(SLACK_READ)).rejects.toThrow("secret message text");

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("chat context read failed", {
      operation: "read-channel",
      bot: "notes",
      chatId: "C0123",
      limit: READ_CHANNEL_DEFAULT,
      errorType: "Error",
    });
  });
});

describe("poster read repository check", () => {
  it("refuses a thread read from a repository the bot is not bound to", async () => {
    const { poster, chatMock } = await contextSetup({ repository: "octo/other" });

    await expect(
      poster({ operation: "read", token: "jwt", bot: "garden", threadId: GARDEN_THREAD }),
    ).rejects.toThrow(/not bound to octo\/other/);
    expect(chatMock.thread).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const { poster } = await contextSetup();

    await expect(
      poster({ operation: "read", bot: "garden", threadId: GARDEN_THREAD }),
    ).rejects.toThrow();
  });
});
