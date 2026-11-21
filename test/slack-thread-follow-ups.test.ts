import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelMention, channelMessage, slackEnrolledHarness } from "./helpers/slack-fixtures.js";

const THREAD_TS = "1699999999.000100";

describe("Slack thread follow-ups under respond_to: mention", () => {
  let harness: Awaited<ReturnType<typeof slackEnrolledHarness>>;
  beforeEach(async () => {
    harness = await slackEnrolledHarness();
  });
  afterEach(() => harness.close());

  it("answers an untagged reply in a thread the bot was mentioned in", async () => {
    await harness.receive(channelMention(THREAD_TS));
    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(1);

    await harness.receive(channelMessage("1700000001.000100", THREAD_TS));

    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(harness.api.calls.filter((call) => call.method === "reactions.add")).toHaveLength(2);
  });

  it("ignores an untagged top-level channel message", async () => {
    await harness.receive(channelMessage("1700000002.000100"));

    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("ignores an untagged reply in a thread the bot was never addressed in", async () => {
    await harness.receive(channelMessage("1700000003.000100", "1699999000.000100"));

    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
