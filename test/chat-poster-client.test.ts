import { describe, expect, it } from "vitest";
import { MESSAGE_TEXT_MAX } from "../src/lambda/chat-context.js";
import { THREAD_WINDOW } from "../src/mcp/poster-chat-client.js";
import { scannedRange } from "./helpers/chat-context-fixtures.js";
import {
  CURRENT,
  channelMessage,
  connectChatServer,
  OTHER,
} from "./helpers/chat-server-fixtures.js";
import { BOT, CHAT, fakePosterChat, storedThread } from "./helpers/poster-chat-client-fixtures.js";

const ids = (messages: { id: string }[]) => messages.map((m) => m.id);

describe("poster chat client", () => {
  it("binds every call to the bot, the derived chat, the dispatched thread and a fresh token", async () => {
    const { client, requests } = fakePosterChat();

    const { threads, scanned } = await client.listThreads({ limit: 5 });
    await client.readChannel({ limit: 7 });

    expect(threads).toHaveLength(2);
    expect(scanned).toEqual(scannedRange(3, false));
    expect(requests).toEqual([
      {
        operation: "list-threads",
        token: "jwt-1",
        bot: BOT,
        chatId: CHAT,
        threadId: CURRENT,
        limit: 5,
      },
      {
        operation: "read-channel",
        token: "jwt-2",
        bot: BOT,
        chatId: CHAT,
        threadId: CURRENT,
        limit: 7,
      },
    ]);
  });

  it("translates a message ID cursor into the poster's ISO instant", async () => {
    const channel = [channelMessage("3", OTHER), channelMessage("2", OTHER)];
    const { client, requests } = fakePosterChat({ channel });

    await client.readChannel({ limit: 2 });
    await client.readChannel({ limit: 2, before: "2" });

    expect(requests[1]).toMatchObject({ before: channel[1]?.sentAt });
  });

  it("rejects a cursor it never returned", async () => {
    const { client, requests } = fakePosterChat();

    await expect(client.readChannel({ limit: 2, before: "99" })).rejects.toThrow("unknown cursor");
    expect(requests).toEqual([]);
  });

  it("always asks the poster for visible messages only", async () => {
    const { client, requests } = fakePosterChat({ stored: storedThread(1) });

    await client.readThread({ threadId: OTHER, limit: 1 });

    expect(requests).toEqual([expect.objectContaining({ operation: "read", visibleOnly: true })]);
  });

  it("pages a thread backwards from the stored window, oldest first", async () => {
    const { client } = fakePosterChat({ stored: storedThread(6) });
    const read = (before?: string, limit = 2) =>
      client.readThread({ threadId: OTHER, limit, before });

    const first = await read();
    expect(ids(first.messages)).toEqual(["5", "6"]);
    expect(first.scanned).toEqual({ oldest: first.messages[0]?.sentAt, exhausted: false });

    const second = await read("5");
    expect(ids(second.messages)).toEqual(["3", "4"]);

    const last = await read("3", 5);
    expect(ids(last.messages)).toEqual(["1", "2"]);
    expect(last.scanned.exhausted).toBe(true);
  });

  it("never reports a full stored window as exhausted", async () => {
    const { client } = fakePosterChat({ stored: storedThread(THREAD_WINDOW) });

    const { messages, scanned } = await client.readThread({
      threadId: OTHER,
      limit: THREAD_WINDOW,
    });

    expect(messages).toHaveLength(THREAD_WINDOW);
    expect(scanned.exhausted).toBe(false);
  });

  it("clips message text to the poster's cap", async () => {
    const stored = storedThread(1).map((m) => ({ ...m, text: "x".repeat(MESSAGE_TEXT_MAX + 50) }));
    const { client } = fakePosterChat({ stored });

    const { messages } = await client.readThread({ threadId: OTHER, limit: 1 });

    expect(messages[0]?.text).toHaveLength(MESSAGE_TEXT_MAX);
  });

  it("serves the tools without exposing thread IDs, message IDs or the chat ID", async () => {
    const channel = [channelMessage("3", OTHER, "hello"), channelMessage("2", OTHER, "earlier")];
    const { client, requests } = fakePosterChat({ channel, stored: storedThread(3) });
    const server = await connectChatServer(client);

    const threads = await server.call("list_threads");
    const page = await server.call("read_channel", { limit: 2 });
    const cursor = /next_cursor: (cursor-\d+)/.exec(page.text)?.[1];
    const older = await server.call("read_channel", { before: cursor, limit: 2 });
    const thread = await server.call("read_thread", { handle: "thread-1", limit: 2 });
    await server.close();

    expect(threads.text).toContain(
      `scanned back to ${scannedRange(3, false).oldest}, window exhausted: no`,
    );
    expect(thread.text).toContain("stored 3");
    expect(older.isError).toBe(false);
    expect(requests.at(-2)).toMatchObject({ before: channel[1]?.sentAt });
    for (const { text } of [threads, page, older, thread]) {
      for (const secret of [CHAT, CURRENT, OTHER, "jwt"]) expect(text).not.toContain(secret);
    }
  });
});
