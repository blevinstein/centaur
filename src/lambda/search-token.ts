import type { Message, StateAdapter } from "chat";
import { z } from "zod";
import { threadKey } from "../thread-key.js";

/** A ceiling only: Slack decides when an `action_token` stops working. */
export const SEARCH_TOKEN_TTL_MS = 10 * 60 * 1000;

const eventSchema = z.object({ action_token: z.string().min(1) });

export interface StoredSearchToken {
  token: string;
  userId: string;
  messageId: string;
  capturedAt: string;
}

export const searchTokenKey = (bot: string, threadId: string) =>
  `search-token:${threadKey(bot, threadId)}`;

export type SearchTokenStore = ReturnType<typeof createSearchTokenStore>;

/** The Slack `action_token` of the latest message that carried one, per thread, until its TTL. */
export function createSearchTokenStore(
  state: StateAdapter,
  bot: string,
  now: () => Date = () => new Date(),
) {
  return {
    /** Stores the message's token and returns whether it had one; a message without one leaves the stored token alone. */
    async capture(threadId: string, message: Pick<Message, "id" | "raw" | "author">) {
      const parsed = eventSchema.safeParse(message.raw);
      if (!parsed.success) return false;
      const stored: StoredSearchToken = {
        token: parsed.data.action_token,
        userId: message.author.userId,
        messageId: message.id,
        capturedAt: now().toISOString(),
      };
      await state.set(searchTokenKey(bot, threadId), stored, SEARCH_TOKEN_TTL_MS);
      return true;
    },
    read: (threadId: string) => state.get<StoredSearchToken>(searchTokenKey(bot, threadId)),
  };
}
