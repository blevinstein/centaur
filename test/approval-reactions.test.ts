import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_EMOJI,
  APPROVAL_STATES,
  type ApprovalState,
  showApprovalState,
} from "../src/lambda/approval-reactions.js";
import { fakeLogger } from "./helpers/receiver-fixtures.js";

const show = (platform: "telegram" | "slack", state: ApprovalState) => {
  const adapter = {
    addReaction: vi.fn(async (..._args: unknown[]) => {}),
    removeReaction: vi.fn(async (..._args: unknown[]) => {}),
  };
  const logger = fakeLogger();
  const done = showApprovalState({
    adapter,
    bot: { name: "garden", platform },
    threadId: "thread",
    messageId: "7",
    state,
    logger,
  });
  return { adapter, logger, done };
};

describe("the approval emoji table", () => {
  it.each(["telegram", "slack"] as const)("has three distinct states for %s", (platform) => {
    const names = APPROVAL_STATES.map((state) => APPROVAL_EMOJI[platform].emoji[state]);
    expect(new Set(names).size).toBe(3);
  });
});

describe("showApprovalState", () => {
  it.each(APPROVAL_STATES)(
    "on Telegram sets %s with one call that replaces the rest",
    async (state) => {
      const { adapter, done } = show("telegram", state);
      await done;

      expect(adapter.removeReaction).not.toHaveBeenCalled();
      expect(adapter.addReaction).toHaveBeenCalledExactlyOnceWith(
        "thread",
        "7",
        APPROVAL_EMOJI.telegram.emoji[state],
      );
    },
  );

  it("on Slack removes the other two states and adds the new one", async () => {
    const { adapter, done } = show("slack", "approved");
    await done;

    expect(adapter.removeReaction.mock.calls.map(([, , name]) => name)).toEqual([
      APPROVAL_EMOJI.slack.emoji.waiting,
      APPROVAL_EMOJI.slack.emoji.denied,
    ]);
    expect(adapter.addReaction).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "7",
      APPROVAL_EMOJI.slack.emoji.approved,
    );
  });

  it("on Slack ignores a state that was not on the message", async () => {
    const { adapter, logger, done } = show("slack", "waiting");
    adapter.removeReaction.mockRejectedValue(new Error("no_reaction"));
    await done;

    expect(adapter.addReaction).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs the bot, platform and state only when the reaction fails", async () => {
    const { adapter, logger, done } = show("slack", "denied");
    adapter.addReaction.mockRejectedValue(new Error("secret text of message 7"));
    await expect(done).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("failed to show the approval state", {
      bot: "garden",
      platform: "slack",
      state: "denied",
    });
  });
});
