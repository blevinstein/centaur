import type { Adapter, Logger } from "chat";
import type { Platform } from "../config/index.js";

export const APPROVAL_STATES = ["waiting", "approved", "denied"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

interface ApprovalEmoji {
  /** Chat SDK emoji names, or raw names the platform accepts. */
  emoji: Record<ApprovalState, string>;
  /** Adding a reaction replaces the bot's others (Telegram), so nothing needs removing first. */
  replaces: boolean;
}

/** Telegram accepts a fixed set of reaction emoji; these come from it (👀 stays the working one). */
export const APPROVAL_EMOJI: Record<Platform, ApprovalEmoji> = {
  telegram: {
    emoji: { waiting: "thinking", approved: "thumbs_up", denied: "thumbs_down" },
    replaces: true,
  },
  slack: {
    emoji: {
      waiting: "hourglass_flowing_sand",
      approved: "white_check_mark",
      denied: "no_entry_sign",
    },
    replaces: false,
  },
};

export interface ApprovalReaction {
  adapter: Pick<Adapter, "addReaction" | "removeReaction">;
  bot: { name: string; platform: Platform };
  threadId: string;
  messageId: string;
  state: ApprovalState;
  logger: Pick<Logger, "warn">;
}

/**
 * Leaves exactly one of the three states on the message. Best-effort: a failure is logged with the
 * bot, platform and state only and never thrown.
 */
export async function showApprovalState({
  adapter,
  bot,
  threadId,
  messageId,
  state,
  logger,
}: ApprovalReaction) {
  const { emoji, replaces } = APPROVAL_EMOJI[bot.platform];
  try {
    if (!replaces) {
      for (const other of APPROVAL_STATES) {
        if (other === state) continue;
        await adapter.removeReaction(threadId, messageId, emoji[other]).catch(() => undefined);
      }
    }
    await adapter.addReaction(threadId, messageId, emoji[state]);
  } catch {
    logger.warn("failed to show the approval state", {
      bot: bot.name,
      platform: bot.platform,
      state,
    });
  }
}
