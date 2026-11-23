import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webhookSecretParameter } from "../src/lambda/connection-paths.js";
import { botStatePrefix } from "../src/lambda/registry.js";
import { threadKey } from "../src/thread-key.js";
import {
  gardenParameters,
  groupMessage,
  slackChannelChat,
  slackMention,
  twoConnectionHarness,
} from "./helpers/connection-fixtures.js";
import { CONNECT_FAILURE } from "./helpers/strict-state.js";

const PREFIX = botStatePrefix("garden");

describe("a bot with a Telegram and a Slack connection", () => {
  let harness: Awaited<ReturnType<typeof twoConnectionHarness>>;
  beforeEach(async () => {
    harness = await twoConnectionHarness();
  });
  afterEach(() => harness.close());

  it("routes each webhook to its own connection and dispatches to the bot's repo", async () => {
    expect((await harness.receive(groupMessage())).status).toBe(200);
    expect((await harness.receive(slackMention())).status).toBe(200);

    expect(harness.dispatched()).toEqual([
      expect.objectContaining({ bot: "garden", thread_id: expect.stringMatching(/^telegram:/) }),
      expect.objectContaining({ bot: "garden", thread_id: expect.stringMatching(/^slack:/) }),
    ]);
    expect(harness.dispatcher.dispatch.mock.calls.map(([repo]) => repo)).toEqual([
      "octo/garden",
      "octo/garden",
    ]);
  });

  it("applies each platform's respond_to: all answers an unaddressed Telegram message, mention ignores an unaddressed Slack one", async () => {
    await harness.receive(groupMessage());
    await harness.receive(slackChannelChat());

    expect(harness.dispatched().map((payload) => payload.thread_id)).toEqual([
      expect.stringMatching(/^telegram:/),
    ]);
  });

  it("verifies each webhook against its own connection's secret", async () => {
    const telegramPath = groupMessage();
    const crossed = new Request("https://example.test/slack/garden", {
      method: "POST",
      headers: telegramPath.headers,
      body: await telegramPath.text(),
    });

    expect((await harness.receive(crossed)).status).toBe(401);
    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("answers 404 for a platform the bot has no route for", async () => {
    const request = new Request("https://example.test/discord/garden", { method: "POST" });

    expect((await harness.receive(request)).status).toBe(404);
  });

  it("connects each connection's adapter once on the shared bot prefix", () => {
    expect(harness.strict.prefixes().sort()).toEqual(["", PREFIX]);
    expect(harness.strict.connects("")).toBe(1);
    expect(harness.strict.connects(PREFIX)).toBe(2);
  });

  it("keeps the same message on two platforms apart: distinct thread keys and dedupe keys", async () => {
    await harness.receive(groupMessage());
    await harness.receive(slackMention());
    const [telegram, slack] = harness.dispatched() as { thread_id: string; message_id: string }[];

    expect(threadKey("garden", telegram?.thread_id ?? "")).not.toBe(
      threadKey("garden", slack?.thread_id ?? ""),
    );
    expect(await harness.botState.get(`dedupe:telegram:${telegram?.message_id}`)).toBe(true);
    expect(await harness.botState.get(`dedupe:slack:${slack?.message_id}`)).toBe(true);
  });

  it("keeps a thread key unchanged by the platform split", () => {
    expect(threadKey("garden", "telegram:123:1")).not.toBe(threadKey("garden", "slack:123:1"));
  });
});

describe("a bot with a connection that is not served", () => {
  let harness: Awaited<ReturnType<typeof twoConnectionHarness>> | undefined;
  afterEach(() => harness?.close());

  it("serves only the connection the registry entry lists", async () => {
    harness = await twoConnectionHarness({ registered: { slack: { respond_to: "mention" } } });

    await harness.receive(groupMessage());
    await harness.receive(slackMention());

    expect(harness.dispatched().map((payload) => payload.thread_id)).toEqual([
      expect.stringMatching(/^slack:/),
    ]);
  });

  it("serves nothing for a bot with no registry entry", async () => {
    harness = await twoConnectionHarness({ registered: {} });

    await harness.receive(groupMessage());
    await harness.receive(slackMention());

    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("keeps serving the other connection when one fails to connect, logging bot and platform", async () => {
    harness = await twoConnectionHarness({ failConnects: { [PREFIX]: 1 } });

    expect((await harness.receive(groupMessage())).status).toBe(404);
    await harness.receive(slackMention());

    expect(harness.dispatched().map((payload) => payload.thread_id)).toEqual([
      expect.stringMatching(/^slack:/),
    ]);
    expect(harness.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("not served"),
      {
        bot: "garden",
        platform: "telegram",
        error: expect.objectContaining({ message: CONNECT_FAILURE }),
      },
    );
  });

  it("fails startup when no connection can start", async () => {
    await expect(twoConnectionHarness({ failConnects: { [PREFIX]: 2 } })).rejects.toThrow(
      "no connection could be started",
    );
  });

  it("does not serve a connection whose secrets are incomplete", async () => {
    const { [webhookSecretParameter("garden", "slack")]: _secret, ...rest } = gardenParameters();
    harness = await twoConnectionHarness({ parameters: rest });

    await harness.receive(groupMessage());
    expect((await harness.receive(slackMention())).status).toBe(404);

    expect(harness.dispatched()).toHaveLength(1);
  });
});
