import { UNREACT_MAX_MESSAGES } from "../lambda/poster.js";
import type { PosterClient } from "./aws.js";

export interface ReactionSource {
  bot: string;
  threadId: string;
  messageIds: string[];
}

/** Best-effort: a failure is reported as a warning and never fails the job. */
export async function clearReactions(poster: PosterClient, source: ReactionSource | undefined) {
  if (!source) return;
  const { bot, threadId, messageIds } = source;
  try {
    for (let start = 0; start < messageIds.length; start += UNREACT_MAX_MESSAGES) {
      await poster.call({
        operation: "unreact",
        bot,
        threadId,
        messageIds: messageIds.slice(start, start + UNREACT_MAX_MESSAGES),
      });
    }
  } catch (error) {
    console.warn(`::warning::could not clear reactions: ${(error as Error).message}`);
  }
}
