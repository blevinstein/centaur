import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedParameter } from "../src/lambda/connection-paths.js";
import {
  channelMention,
  reactionOn,
  SLACK_CHANNEL_ID,
  slackApprovalHarness,
} from "./helpers/slack-fixtures.js";

describe("Slack admin reaction approval", () => {
  let harness: Awaited<ReturnType<typeof slackApprovalHarness>>;
  beforeEach(async () => {
    harness = await slackApprovalHarness();
  });
  afterEach(() => harness.close());

  it("approves a chat when the admin reacts +1 to the request DM", async () => {
    expect((await harness.receive(channelMention())).status).toBe(200);
    const dm = harness.adminDmPost();
    expect(dm?.body.text).toContain("Access request");

    const dmTs = dm?.response.ts as string;
    expect((await harness.receive(reactionOn(dmTs, "+1"))).status).toBe(200);

    expect(
      harness.params.values[approvedParameter("notes", "slack", "chat", SLACK_CHANNEL_ID)],
    ).toBeDefined();
    expect(harness.api.posts().at(-1)?.body).toMatchObject({ channel: SLACK_CHANNEL_ID });
    expect(harness.api.posts().at(-1)?.body.text).toContain("approved");
  });
});
