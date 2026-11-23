import { afterEach, describe, expect, it, vi } from "vitest";
import { THREAD_META_TTL_MS } from "../src/lambda/thread-meta.js";
import { SLACK_POST_THREAD_ID } from "./helpers/poster-fixtures.js";
import {
  DAY_MS,
  dynamoThreadMeta,
  gardenPoster,
  memoryThreadMeta,
  readThread,
  START_GARDEN_CHANNEL,
  START_HOUSEHOLD,
  TELEGRAM_THREAD,
} from "./helpers/thread-meta-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("thread-meta store", () => {
  it("round-trips the policy with who set it and when", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const threadMeta = await memoryThreadMeta();

    await threadMeta.write("t1", { setBy: "start-thread", context: "resume" });

    await expect(threadMeta.read("t1")).resolves.toEqual({
      context: "resume",
      setBy: "start-thread",
      at: new Date().toISOString(),
    });
    await expect(threadMeta.read("other")).resolves.toBeUndefined();
  });

  it("stores a record with no policy when none is given", async () => {
    const threadMeta = await memoryThreadMeta();

    await threadMeta.write("t1", { setBy: "start-thread" });

    await expect(threadMeta.read("t1")).resolves.not.toHaveProperty("context");
  });

  it("expires after 90 days and refreshes the expiry on every read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { threadMeta, expiryOf } = await dynamoThreadMeta();
    await threadMeta.write("t1", { setBy: "start-thread", context: "fresh" });
    expect(await expiryOf("t1")).toBe(start + THREAD_META_TTL_MS);

    vi.setSystemTime(start + 60 * DAY_MS);
    await threadMeta.read("t1");

    expect(await expiryOf("t1")).toBe(start + 60 * DAY_MS + THREAD_META_TTL_MS);
  });

  it("gives a destination thread no expiry, on write and after a read", async () => {
    const { threadMeta, expiryOf } = await dynamoThreadMeta();

    await threadMeta.write("t1", { setBy: "start-thread", destination: "plan" });
    expect(await expiryOf("t1")).toBeUndefined();

    await threadMeta.read("t1");
    expect(await expiryOf("t1")).toBeUndefined();
  });
});

describe("poster thread-meta", () => {
  it("stores the context passed to start-thread and read returns it as policy", async () => {
    const { poster } = await gardenPoster();

    await poster({ ...START_HOUSEHOLD, context: "resume" });
    const result = await poster(readThread(TELEGRAM_THREAD));

    expect(result).toEqual({ messages: [], policy: "resume" });
  });

  it("omits policy from read when the thread started without a context", async () => {
    const { poster, gardenThreadMeta } = await gardenPoster();

    await poster(START_HOUSEHOLD);

    await expect(gardenThreadMeta().read(TELEGRAM_THREAD)).resolves.toBeDefined();
    await expect(poster(readThread(TELEGRAM_THREAD))).resolves.toEqual({ messages: [] });
  });

  it("omits policy from read for a thread with no record", async () => {
    const { poster } = await gardenPoster();

    await expect(poster(readThread(TELEGRAM_THREAD))).resolves.toEqual({ messages: [] });
  });

  it("rejects an unknown context policy", async () => {
    const { poster } = await gardenPoster();

    await expect(poster({ ...START_HOUSEHOLD, context: "forever" })).rejects.toThrow();
  });

  it("keeps a record per connection on the bot's shared state", async () => {
    const { poster } = await gardenPoster({ twoConnections: true });

    await poster({ ...START_HOUSEHOLD, platform: "telegram", context: "resume" });
    await poster({ ...START_GARDEN_CHANNEL, platform: "slack", context: "fresh" });

    await expect(poster(readThread(TELEGRAM_THREAD))).resolves.toMatchObject({ policy: "resume" });
    await expect(poster(readThread(SLACK_POST_THREAD_ID))).resolves.toMatchObject({
      policy: "fresh",
    });
  });
});
