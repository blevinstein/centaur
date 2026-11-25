import { MESSAGE_TEXT_MAX } from "../lambda/chat-context.js";
import { clip } from "../lambda/text.js";
import { type PosterClient, readThreadMessages } from "../workflows/aws.js";
import { SafeError } from "../workflows/safe-error.js";
import type { ChatMessage } from "../workflows/transcript.js";
import type { ChatPosterClient } from "./chat-poster-client.js";

/** The newest messages the poster's `read` returns for a thread (the stored history window). */
export const THREAD_WINDOW = 100;

export interface PosterChatTarget {
  bot: string;
  /** The thread the turn was dispatched for; the poster derives the one chat the turn may read. */
  threadId: string;
}

/** Thread IDs are `<platform>:<chat>:<thread>`; the poster re-derives the chat and rejects a mismatch. */
export const chatIdOfThread = (threadId: string) => {
  const chatId = threadId.split(":")[1];
  if (!chatId) throw new SafeError("the thread ID has no chat");
  return chatId;
};

const instant = (value: string) => Date.parse(value);

/**
 * Backs the chat tools with the poster. The MCP server pages by message ID, the poster by instant,
 * so the client remembers the send time of every message it returns and translates a cursor back.
 */
export function createPosterChatClient(
  poster: PosterClient,
  fetchToken: () => Promise<string>,
  { bot, threadId }: PosterChatTarget,
): ChatPosterClient {
  const chatId = chatIdOfThread(threadId);
  const sentAtById = new Map<string, string>();
  const remember = <M extends ChatMessage>(messages: M[]) => {
    for (const { id, sentAt } of messages) sentAtById.set(id, sentAt);
    return messages;
  };
  const sentAtOf = (cursor: string) => {
    const sentAt = sentAtById.get(cursor);
    if (sentAt === undefined) throw new SafeError("unknown cursor");
    return sentAt;
  };
  const target = async () => ({ token: await fetchToken(), bot, chatId, threadId });

  return {
    listThreads: async ({ limit }) => poster.listThreads({ ...(await target()), limit }),
    async readChannel({ limit, before }) {
      const result = await poster.readChannel({
        ...(await target()),
        limit,
        ...(before === undefined ? {} : { before: sentAtOf(before) }),
      });
      return { ...result, messages: remember(result.messages) };
    },
    async readThread({ threadId: readId, limit, before }) {
      const stored = await readThreadMessages(poster, {
        token: await fetchToken(),
        bot,
        threadId: readId,
        visibleOnly: true,
      });
      remember(stored);
      const cutoff = before === undefined ? Number.POSITIVE_INFINITY : instant(sentAtOf(before));
      const older = stored.filter((m) => instant(m.sentAt) < cutoff);
      const page = older.slice(-limit).map((m) => ({ ...m, text: clip(m.text, MESSAGE_TEXT_MAX) }));
      return {
        messages: page,
        scanned: {
          oldest: page[0]?.sentAt ?? null,
          exhausted: older.length <= page.length && stored.length < THREAD_WINDOW,
        },
      };
    },
  };
}
