import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadKey } from "../src/thread-key.js";
import {
  TAIL_BOT,
  TAIL_CHAT_ID,
  TAIL_NOW,
  TAIL_STRANGER,
  TAIL_TABLE,
  TAIL_USER,
  tailMessage,
} from "./helpers/chat-tail-fixtures.js";
import { createTailHarness } from "./helpers/cli.js";

const CHANNEL = `telegram:${TAIL_CHAT_ID}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TAIL_NOW);
});

afterEach(() => vi.useRealTimers());

describe("chat tail on Telegram", () => {
  it("lists enrolled and bot messages oldest first and counts what the sender filter dropped", async () => {
    const cli = await createTailHarness(["telegram"], {
      history: {
        [TAIL_CHAT_ID]: [
          tailMessage({ id: "m4", isMe: true, minute: 40, text: "ok" }),
          tailMessage({ id: "m3", userId: TAIL_STRANGER, minute: 35 }),
          tailMessage({ id: "m2", isBot: true, userId: "777", minute: 32 }),
          tailMessage({ id: "m1", minute: 30, attachments: 2, text: "hello there" }),
        ],
      },
    });

    await cli.run("chat", "tail", TAIL_BOT);

    const thread = threadKey(TAIL_BOT, `${CHANNEL}:77`);
    expect(cli.output).toEqual([
      [
        "time (UTC)            platform  author  thread        files  chars",
        `2026-01-02T03:30:00Z  telegram  user    ${thread}  2      11`,
        `2026-01-02T03:40:00Z  telegram  bot     ${thread}  0      2`,
        "2 shown, 2 dropped by the sender filter; oldest examined 2026-01-02T03:30:00.000Z; window exhausted.",
      ].join("\n"),
    ]);
  });

  it("prints no chat, thread or user ID", async () => {
    const cli = await createTailHarness(["telegram"], {
      history: {
        [TAIL_CHAT_ID]: [tailMessage({ minute: 30 }), tailMessage({ userId: TAIL_STRANGER })],
      },
    });

    await cli.run("chat", "tail", TAIL_BOT, "--text");

    const printed = cli.output.join("\n");
    for (const secret of [TAIL_CHAT_ID, TAIL_USER, TAIL_STRANGER, "telegram:", "tg-token"]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("limits the window to the last --minutes", async () => {
    const cli = await createTailHarness(["telegram"], {
      history: {
        [TAIL_CHAT_ID]: [
          tailMessage({ id: "new", minute: 50 }),
          tailMessage({ id: "old", minute: 10 }),
        ],
      },
    });

    await cli.run("chat", "tail", TAIL_BOT, "--minutes", "30");

    expect(cli.output[0]).toContain("2026-01-02T03:50:00Z");
    expect(cli.output[0]).not.toContain("2026-01-02T03:10:00Z");
    expect(cli.output[0]).toContain("1 shown, 0 dropped");
  });

  it("shows the newest --limit messages and says the window was not exhausted", async () => {
    const cli = await createTailHarness(["telegram"], {
      history: {
        [TAIL_CHAT_ID]: [
          tailMessage({ id: "c", minute: 50 }),
          tailMessage({ id: "b", minute: 40 }),
          tailMessage({ id: "a", minute: 30 }),
        ],
      },
    });

    await cli.run("chat", "tail", TAIL_BOT, "--limit", "2");

    const [out] = cli.output;
    expect(out).toContain("03:40:00Z");
    expect(out).toContain("03:50:00Z");
    expect(out).not.toContain("03:30:00Z");
    expect(out).toContain(
      "2 shown, 0 dropped by the sender filter; oldest examined 2026-01-02T03:40:00.000Z; window not exhausted.",
    );
  });

  it("prints text only with --text, on one line clipped to 120 characters", async () => {
    const history = {
      [TAIL_CHAT_ID]: [tailMessage({ text: `first\nsecond ${"x".repeat(200)}` })],
    };
    const plain = await createTailHarness(["telegram"], { history });
    await plain.run("chat", "tail", TAIL_BOT);
    const withText = await createTailHarness(["telegram"], { history });
    await withText.run("chat", "tail", TAIL_BOT, "--text");

    expect(plain.output[0]).not.toContain("first");
    const row = withText.output[0]?.split("\n")[1] ?? "";
    expect(row).toContain("first second xxx");
    expect(row.split("  ").at(-1)).toHaveLength(120);
    expect(row.endsWith("…")).toBe(true);
  });

  it("reads the bot's state prefix, connected, and only approved chats", async () => {
    const cli = await createTailHarness(["telegram"], {
      history: { "-999": [tailMessage({ text: "unapproved chat" })] },
    });

    await cli.run("chat", "tail", TAIL_BOT, "--text");

    expect(cli.output[0]).not.toContain("unapproved chat");
    expect(cli.fake.createState).toHaveBeenCalledWith(TAIL_TABLE, `bot:${TAIL_BOT}:`);
    expect(cli.fake.states.connects(`bot:${TAIL_BOT}:`)).toBe(1);
  });

  it("rejects counts that are not positive whole numbers", async () => {
    const cli = await createTailHarness(["telegram"]);

    await expect(cli.run("chat", "tail", TAIL_BOT, "--limit", "0")).rejects.toThrow(
      "--limit must be a whole number of at least 1.",
    );
    await expect(cli.run("chat", "tail", TAIL_BOT, "--minutes", "x")).rejects.toThrow(
      "--minutes must be a whole number of at least 1.",
    );
  });
});

describe("chat tail connection and table", () => {
  it("requires --platform with several connections and rejects unknown ones", async () => {
    const cli = await createTailHarness(["telegram", "slack"]);

    await expect(cli.run("chat", "tail", TAIL_BOT)).rejects.toThrow(
      'Bot "garden" has several connections (telegram, slack); pass --platform.',
    );
    await expect(cli.run("chat", "tail", TAIL_BOT, "--platform", "signal")).rejects.toThrow(
      'Unknown platform "signal"',
    );
    await expect(cli.run("chat", "tail", "nobody")).rejects.toThrow('Unknown bot "nobody".');
    await cli.run("chat", "tail", TAIL_BOT, "--platform", "slack");
    expect(cli.output[0]).toContain("0 shown");
  });

  it.each([
    ["the flag", ["--table", "from-flag"], { CENTAUR_STATE_TABLE: "from-env" }, "from-flag"],
    ["the environment", [], { CENTAUR_STATE_TABLE: "from-env" }, "from-env"],
    ["the SSM parameter", [], {}, TAIL_TABLE],
  ])("takes the table from %s", async (_source, flags, env, expected) => {
    const cli = await createTailHarness(["telegram"], { env });

    await cli.run("chat", "tail", TAIL_BOT, ...flags);

    expect(cli.fake.createState).toHaveBeenCalledWith(expected, expect.any(String));
  });

  it("fails naming all three sources when none gives a table", async () => {
    const cli = await createTailHarness(["telegram"], { parameterTable: null });

    await expect(cli.run("chat", "tail", TAIL_BOT)).rejects.toThrow(
      "No state table: pass --table, set CENTAUR_STATE_TABLE, or deploy the stack that publishes /centaur/state-table.",
    );
  });
});

describe("chat tail on Slack", () => {
  const SLACK_CHANNEL = "slack:C0123";

  it("reads only approved channels through the same filter", async () => {
    const cli = await createTailHarness(["slack"], {
      pages: {
        C0123: [
          tailMessage({ id: "b", userId: TAIL_STRANGER, minute: 50 }),
          tailMessage({ id: "a", minute: 40, text: "slack hello" }),
        ],
        C9999: [tailMessage({ text: "unapproved channel" })],
      },
      nextCursor: "more",
    });

    await cli.run("chat", "tail", TAIL_BOT, "--limit", "500", "--text");

    expect(cli.fake.fetchChannelMessages).toHaveBeenCalledTimes(1);
    expect(cli.fake.fetchChannelMessages).toHaveBeenCalledWith(
      SLACK_CHANNEL,
      expect.objectContaining({ limit: 200 }),
    );
    expect(cli.output[0]).toContain("slack hello");
    expect(cli.output[0]).toContain("1 shown, 1 dropped by the sender filter");
    expect(cli.output[0]).toContain("window not exhausted.");
  });

  it("prints a Slack API error code and nothing else from the error", async () => {
    const error = Object.assign(new Error("An API error occurred: channel_not_found xoxb-secret"), {
      code: "slack_webapi_platform_error",
      data: { error: "channel_not_found" },
    });
    const cli = await createTailHarness(["slack"], { slackError: error });

    const failure = await cli.run("chat", "tail", TAIL_BOT).catch((caught: Error) => caught);

    expect(failure).toEqual(new Error("Reading slack history failed: channel_not_found."));
    expect(String(failure)).not.toContain("xoxb");
  });
});
