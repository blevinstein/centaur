import { type FileUpload, type Logger, Message } from "chat";
import type { PosterChat } from "./poster.js";

export interface ChannelHistoryTarget {
  chat: PosterChat;
  botName: string;
  logger: Pick<Logger, "warn">;
}

/**
 * Posts into a thread and, on platforms whose history the Chat SDK stores (Telegram), also records
 * the sent message in the chat-level list the chat tools read, where `Chat` itself records only
 * incoming messages. Files follow the text in a post of their own, so a platform's caption limit
 * never cuts the reply. Every poster post path goes through this. A failed record never fails the post.
 */
export async function postInThread(
  { chat, botName, logger }: ChannelHistoryTarget,
  threadId: string,
  text: string,
  files: FileUpload[] = [],
) {
  const thread = chat.thread(threadId);
  const sent = await thread.post(text);
  const { adapter, channelId } = thread;
  if ((adapter.persistThreadHistory || adapter.persistMessageHistory) && channelId !== thread.id) {
    try {
      await chat.history.thread.append(channelId, new Message(sent));
    } catch {
      logger.warn("channel history append failed", { bot: botName, platform: adapter.name });
    }
  }
  if (files.length > 0) await thread.post({ raw: "", files });
  return sent;
}
