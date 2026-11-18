import type { Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import { createDynamoDbState } from "../src/dynamodb-state/index.js";
import { createFreshTable, scanItems } from "./helpers/dynamodb-local.js";
import {
  createGate,
  FAKE_CHANNEL_ID,
  FAKE_PLATFORM,
  FAKE_THREAD_ID,
  fakeIncomingMessage,
  startFakeChat,
} from "./helpers/fake-platform.js";

const HISTORY_TTL_MS = 60_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60_000;
const QUEUE_ENTRY_TTL_MS = 5_000;
const CLOCK_SLACK_MS = 5_000;

const ids = (messages: Message[]) => messages.map((message) => message.id);
const pks = (items: Record<string, unknown>[]) => items.map((item) => String(item.pk)).sort();

function expectExpiryWithin(item: Record<string, unknown> | undefined, ttlMs: number) {
  const expiresAt = item?.expiresAt as number;
  expect(expiresAt).toBeGreaterThan(Date.now() + ttlMs - CLOCK_SLACK_MS);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + ttlMs);
  expect(item?.ttl).toBe(Math.ceil(expiresAt / 1000));
}

async function freshState() {
  const table = await createFreshTable();
  return { table, state: createDynamoDbState(table) };
}

describe("Chat on the DynamoDB state adapter: default drop strategy", () => {
  it("keeps history trimmed with a TTL, dedupes, subscribes, and releases the lock", async () => {
    const { table, state } = await freshState();
    const { chat, receive } = await startFakeChat({
      state,
      history: { thread: { maxMessages: 3, ttlMs: HISTORY_TTL_MS } },
    });
    const seen: string[] = [];
    chat.onNewMention(async (thread, message) => {
      seen.push(`mention:${message.id}`);
      await thread.subscribe();
      await thread.setState({ turns: 1 });
    });
    chat.onSubscribedMessage(async (_thread, message) => {
      seen.push(`subscribed:${message.id}`);
    });

    for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
      await receive(fakeIncomingMessage(id));
    }
    await receive(fakeIncomingMessage("m5"));

    expect(seen).toEqual([
      "mention:m1",
      "subscribed:m2",
      "subscribed:m3",
      "subscribed:m4",
      "subscribed:m5",
    ]);
    expect(await state.isSubscribed(FAKE_THREAD_ID)).toBe(true);
    expect(await state.get(`thread-state:${FAKE_THREAD_ID}`)).toEqual({ turns: 1 });

    const thread = await state.getList<{ id: string }>(`msg-history:${FAKE_THREAD_ID}`);
    const channel = await state.getList<{ id: string }>(`msg-history:${FAKE_CHANNEL_ID}`);
    expect(thread.map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);
    expect(channel.map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);

    const items = await scanItems(table);
    const byPk = (pk: string) => items.filter((item) => item.pk === pk);
    expect(byPk(`list:msg-history:${FAKE_THREAD_ID}`)).toHaveLength(4);
    expectExpiryWithin(byPk(`list:msg-history:${FAKE_THREAD_ID}`)[0], HISTORY_TTL_MS);
    expectExpiryWithin(byPk(`kv:dedupe:${FAKE_PLATFORM}:m5`)[0], DEDUPE_TTL_MS);
    expectExpiryWithin(byPk(`kv:thread-state:${FAKE_THREAD_ID}`)[0], THREAD_STATE_TTL_MS);
    expect(pks(items).filter((pk) => pk.startsWith("lock:"))).toEqual([]);
  });
});

describe("Chat on the DynamoDB state adapter: queue strategy", () => {
  async function chatWithBlockedFirstMessage(concurrency: object) {
    const { table, state } = await freshState();
    const harness = await startFakeChat({
      state,
      concurrency: { strategy: "queue", ...concurrency },
    });
    const gate = createGate();
    const handled = vi.fn<(id: string, skipped: string[]) => void>();
    harness.chat.onNewMention(async (_thread, message, context) => {
      handled(message.id, ids(context?.skipped ?? []));
      if (message.id === "m1") {
        await gate.opened;
      }
    });
    return { ...harness, table, state, gate, handled };
  }

  it("queues behind the held lock, then drains the latest with the earlier ones skipped", async () => {
    const { receive, table, state, gate, handled } = await chatWithBlockedFirstMessage({
      queueEntryTtlMs: QUEUE_ENTRY_TTL_MS,
    });

    const first = receive(fakeIncomingMessage("m1"));
    await vi.waitFor(async () => expect(await state.acquireLock(FAKE_THREAD_ID, 1)).toBeNull());
    await receive(fakeIncomingMessage("m2"));
    await receive(fakeIncomingMessage("m3"));

    expect(await state.queueDepth(FAKE_THREAD_ID)).toBe(2);
    const queued = (await scanItems(table)).filter((item) => item.pk === `queue:${FAKE_THREAD_ID}`);
    expect(queued).toHaveLength(2);
    expectExpiryWithin(queued[0], QUEUE_ENTRY_TTL_MS);

    gate.open();
    await first;

    expect(handled.mock.calls).toEqual([
      ["m1", []],
      ["m3", ["m2"]],
    ]);
    expect(await state.queueDepth(FAKE_THREAD_ID)).toBe(0);
    expect(await state.acquireLock(FAKE_THREAD_ID, 1000)).not.toBeNull();
  });

  it("drops the oldest queued message beyond maxQueueSize", async () => {
    const { receive, state, gate, handled } = await chatWithBlockedFirstMessage({
      maxQueueSize: 2,
    });

    const first = receive(fakeIncomingMessage("m1"));
    await vi.waitFor(async () => expect(await state.acquireLock(FAKE_THREAD_ID, 1)).toBeNull());
    for (const id of ["m2", "m3", "m4"]) {
      await receive(fakeIncomingMessage(id));
    }
    expect(await state.queueDepth(FAKE_THREAD_ID)).toBe(2);

    gate.open();
    await first;
    expect(handled.mock.calls).toEqual([
      ["m1", []],
      ["m4", ["m3"]],
    ]);
  });

  it("discards queued entries that expired before the lock holder finished", async () => {
    const { receive, state, gate, handled } = await chatWithBlockedFirstMessage({
      queueEntryTtlMs: 20,
    });

    const first = receive(fakeIncomingMessage("m1"));
    await vi.waitFor(async () => expect(await state.acquireLock(FAKE_THREAD_ID, 1)).toBeNull());
    await receive(fakeIncomingMessage("m2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await state.queueDepth(FAKE_THREAD_ID)).toBe(1);

    gate.open();
    await first;

    expect(handled.mock.calls).toEqual([["m1", []]]);
    expect(await state.queueDepth(FAKE_THREAD_ID)).toBe(0);
  });
});

describe("Chat on the DynamoDB state adapter: concurrent strategy with key prefixes", () => {
  it("keeps two bots sharing a table fully isolated and takes no locks", async () => {
    const table = await createFreshTable();
    const bots = await Promise.all(
      ["bot:a:", "bot:b:"].map(async (keyPrefix) => {
        const state = createDynamoDbState({ ...table, keyPrefix });
        const harness = await startFakeChat({ state, concurrency: "concurrent" });
        const handled = vi.fn<(id: string) => void>();
        harness.chat.onNewMention(async (thread, message) => {
          handled(message.id);
          await thread.subscribe();
        });
        harness.chat.onSubscribedMessage(async (_thread, message) => {
          handled(`subscribed:${message.id}`);
        });
        return { ...harness, state, keyPrefix, handled };
      }),
    );
    const [botA, botB] = bots as [(typeof bots)[number], (typeof bots)[number]];

    await Promise.all(bots.map((bot) => bot.receive(fakeIncomingMessage("m1"))));
    await botA.receive(fakeIncomingMessage("m1"));
    await botB.receive(fakeIncomingMessage("m2"));

    expect(botA.handled.mock.calls).toEqual([["m1"]]);
    expect(botB.handled.mock.calls).toEqual([["m1"], ["subscribed:m2"]]);
    expect(await botA.state.isSubscribed(FAKE_THREAD_ID)).toBe(true);

    const items = await scanItems(table);
    expect(items.every((item) => /^bot:[ab]:/.test(String(item.pk)))).toBe(true);
    expect(pks(items).filter((pk) => pk.includes(":lock:"))).toEqual([]);
    expect(await botA.state.getList(`msg-history:${FAKE_THREAD_ID}`)).toHaveLength(1);
    expect(await botB.state.getList(`msg-history:${FAKE_THREAD_ID}`)).toHaveLength(2);
  });
});
