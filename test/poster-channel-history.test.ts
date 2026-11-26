import { describe, expect, it } from "vitest";
import {
  boundWeekly,
  destinationPoster,
  START_WEEKLY,
  START_WEEKLY_PERSISTENT,
  TELEGRAM_TOPIC,
} from "./helpers/destination-fixtures.js";
import {
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_POST_THREAD_ID,
  TOPIC_ID,
} from "./helpers/poster-fixtures.js";

const POST = { operation: "post", bot: "garden", threadId: TELEGRAM_TOPIC, text: "hello" } as const;
const CHANNEL = `telegram:${HOUSEHOLD_CHAT_ID}`;

describe("poster posts are recorded in the chat's history", () => {
  it("post appends the sent message under the channel ID after posting", async () => {
    const { poster, thread, appendHistory } = await posterSetup();

    await poster(POST);

    expect(thread.post).toHaveBeenCalledBefore(appendHistory);
    expect(appendHistory).toHaveBeenCalledExactlyOnceWith(
      CHANNEL,
      expect.objectContaining({ id: "sent-1" }),
    );
  });

  it.each([
    ["a new thread", START_WEEKLY, {}],
    ["a persistent thread's first post", START_WEEKLY_PERSISTENT, {}],
    ["a reused persistent thread", START_WEEKLY_PERSISTENT, { weekly: boundWeekly() }],
  ])("start-thread records %s", async (_name, request, options) => {
    const { poster, appendHistory } = await destinationPoster({
      weekly: boundWeekly({ threadId: undefined }),
      ...options,
    });

    await poster(request);

    expect(appendHistory).toHaveBeenCalledExactlyOnceWith(CHANNEL, expect.anything());
  });

  it("does not record a Slack post, which Slack serves live", async () => {
    const { poster, appendHistory, thread } = await posterSetup();

    await poster({ ...POST, bot: "notes", threadId: SLACK_POST_THREAD_ID });

    expect(thread.post).toHaveBeenCalled();
    expect(appendHistory).not.toHaveBeenCalled();
  });

  it("does not record a post whose thread is the chat itself", async () => {
    const { poster, appendHistory } = await posterSetup();

    await poster({ ...POST, threadId: CHANNEL });

    expect(appendHistory).not.toHaveBeenCalled();
  });

  it("a failed record neither fails the post nor logs message text or IDs", async () => {
    const { poster, appendHistory, logger } = await posterSetup({ repository: "octo/garden" });
    appendHistory.mockRejectedValueOnce(new Error(`rejected hello ${CHANNEL} ${TOPIC_ID}`));

    await expect(poster({ ...POST, token: "jwt" })).resolves.toEqual({ messageId: "sent-1" });

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("channel history append failed", {
      bot: "garden",
      platform: "telegram",
    });
  });
});
