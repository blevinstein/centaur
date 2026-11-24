import { describe, expect, it } from "vitest";
import { postInThread } from "../src/lambda/channel-history.js";
import {
  contextSetup,
  ENROLLED_USER,
  GARDEN_THREAD,
  TELEGRAM_TARGET,
} from "./helpers/chat-context-fixtures.js";
import { TAIL_BOT } from "./helpers/chat-tail-fixtures.js";
import { createTailHarness } from "./helpers/cli.js";
import { realTelegramChat } from "./helpers/real-chat-fixtures.js";
import { fakeLogger } from "./helpers/receiver-fixtures.js";

const LIST = { operation: "list-threads", ...TELEGRAM_TARGET } as const;
const READ = { operation: "read-channel", ...TELEGRAM_TARGET } as const;
const BOT_ONLY_THREAD = "telegram:-100500:88";
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function setup() {
  const real = await realTelegramChat();
  const context = await contextSetup({ chat: real.chat as never });
  const post = (threadId: string, text: string) =>
    postInThread({ chat: real.chat, botName: "garden", logger: fakeLogger() }, threadId, text);
  return { ...real, ...context, post };
}

describe("Telegram chat history on the real Chat and DynamoDB state", () => {
  it("read-channel returns an incoming message stored at chat level", async () => {
    const { poster, receive } = await setup();
    await receive({ text: "hello", topic: 77 });

    const result = await poster(READ);

    expect(result).toMatchObject({
      messages: [{ text: "hello", userId: ENROLLED_USER, fromBot: false, threadId: GARDEN_THREAD }],
      scanned: { exhausted: true },
    });
  });

  it("read-channel returns the bot's own post as from the bot, newest first", async () => {
    const { poster, receive, post } = await setup();
    await receive({ text: "question", topic: 77, date: nowSeconds() - 60 });
    await post(GARDEN_THREAD, "answer");

    const { messages } = (await poster(READ)) as {
      messages: { text: string; fromBot: boolean; threadId: string }[];
    };

    expect(messages.map(({ text, fromBot, threadId }) => [text, fromBot, threadId])).toEqual([
      ["answer", true, GARDEN_THREAD],
      ["question", false, GARDEN_THREAD],
    ]);
  });

  it("list-threads includes a thread that holds only a bot post", async () => {
    const { poster, receive, post } = await setup();
    await receive({ text: "question", topic: 77 });
    await post(BOT_ONLY_THREAD, "scheduled hello");

    const { threads } = (await poster(LIST)) as {
      threads: { threadId: string; title: string; messageCount: number }[];
    };

    expect(
      threads.map(({ threadId, title, messageCount }) => [threadId, title, messageCount]).sort(),
    ).toEqual([
      [GARDEN_THREAD, "question", 1],
      [BOT_ONLY_THREAD, "scheduled hello", 1],
    ]);
  });

  it("read-channel honors limit and before", async () => {
    const { poster, receive } = await setup();
    const base = nowSeconds() - 3600;
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await receive({ text, topic: 77, date: base + index * 60 });
    }

    const limited = (await poster({ ...READ, limit: 2 })) as { messages: { text: string }[] };
    const before = (await poster({
      ...READ,
      before: new Date((base + 120) * 1000).toISOString(),
    })) as { messages: { text: string }[] };

    expect(limited.messages.map(({ text }) => text)).toEqual(["three", "two"]);
    expect(before.messages.map(({ text }) => text)).toEqual(["two", "one"]);
  });

  it("chat tail shows the bot's post and the user's message through the same reader", async () => {
    const { access, receive, post } = await setup();
    await receive({ text: "question", topic: 77, date: nowSeconds() - 120 });
    await post(GARDEN_THREAD, "answer");
    const cli = await createTailHarness(["telegram"], { chatAccess: access });

    await cli.run("chat", "tail", TAIL_BOT, "--text");

    expect(cli.output[0]).toMatch(/user\s.*question\n.*bot\s.*answer/);
  });
});
