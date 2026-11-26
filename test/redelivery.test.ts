import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIVE_UP_TEXT, MAX_REDELIVERIES, RedeliveryRequested } from "../src/lambda/redelivery.js";
import { groupMessage, slackMention, twoConnectionHarness } from "./helpers/connection-fixtures.js";
import { redeliveryHarness } from "./helpers/redelivery-fixtures.js";

describe("withRedelivery", () => {
  it("passes a successful handler through without touching state", async () => {
    const h = redeliveryHarness();

    await h.handle();

    expect(h.values.size).toBe(0);
  });

  it.each([
    ["a dispatch", new Error("repository_dispatch failed with HTTP 502")],
    ["a state table", new Error("DynamoDB throttled")],
    ["an access check", new Error("SSM throttled")],
  ])("releases the dedupe key and asks for redelivery when %s fails", async (_name, failure) => {
    const h = redeliveryHarness({ "dedupe:telegram:telegram:msg-42": true });
    h.handler.mockRejectedValueOnce(failure);

    const error = await h.handle().catch((e) => e);

    expect(error).toBeInstanceOf(RedeliveryRequested);
    expect(error.cause).toBe(failure);
    expect(h.values.has("dedupe:telegram:telegram:msg-42")).toBe(false);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("tells the sender to resend, clears the reaction and stops redelivering after the limit", async () => {
    const h = redeliveryHarness();
    h.handler.mockRejectedValue(new Error("boom"));

    for (let attempt = 0; attempt < MAX_REDELIVERIES; attempt++) {
      await expect(h.handle()).rejects.toBeInstanceOf(RedeliveryRequested);
    }
    await expect(h.handle()).resolves.toBeUndefined();

    expect(h.post).toHaveBeenCalledExactlyOnceWith(GIVE_UP_TEXT);
    expect(h.removeReaction).toHaveBeenCalledOnce();
    expect(h.logger.error).toHaveBeenCalledOnce();
  });

  it("still returns when the give-up notice itself fails", async () => {
    const h = redeliveryHarness({
      "redelivery-attempts:telegram:telegram:msg-42": MAX_REDELIVERIES,
    });
    h.handler.mockRejectedValue(new Error("boom"));
    h.post.mockRejectedValue(new Error("chat unreachable"));

    await expect(h.handle()).resolves.toBeUndefined();

    expect(h.logger.warn).toHaveBeenCalledOnce();
  });
});

describe("the receiver when handling fails", () => {
  let harness: Awaited<ReturnType<typeof twoConnectionHarness>>;
  beforeEach(async () => {
    harness = await twoConnectionHarness();
  });
  afterEach(() => harness.close());

  it("answers 500 and handles the platform's redelivery of the same update", async () => {
    harness.dispatcher.dispatch.mockRejectedValueOnce(new Error("HTTP 502"));

    expect((await harness.receive(groupMessage())).status).toBe(500);
    expect((await harness.receive(groupMessage())).status).toBe(200);

    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(harness.sent).toEqual([]);
  });

  it("handles Slack's retry of a failed event, which the adapter would otherwise drop", async () => {
    harness.dispatcher.dispatch.mockRejectedValueOnce(new Error("HTTP 502"));

    expect((await harness.receive(slackMention({ eventId: "Ev1" }))).status).toBe(500);
    expect((await harness.receive(slackMention({ eventId: "Ev1", retryNum: 1 }))).status).toBe(200);

    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("dedupes a redelivery once the message has been handled", async () => {
    await harness.receive(groupMessage());
    await harness.receive(groupMessage());

    expect(harness.dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("answers 200 and tells the sender to resend after the redeliveries run out", async () => {
    harness.dispatcher.dispatch.mockRejectedValue(new Error("HTTP 502"));

    const statuses = [];
    for (let attempt = 0; attempt <= MAX_REDELIVERIES; attempt++) {
      statuses.push((await harness.receive(groupMessage())).status);
    }

    expect(statuses).toEqual([...Array(MAX_REDELIVERIES).fill(500), 200]);
    expect(harness.sent.map(({ text }) => text)).toEqual([GIVE_UP_TEXT]);
  });
});
