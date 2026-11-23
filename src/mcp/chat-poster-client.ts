import type { ChannelMessage, Scanned, ThreadSummary } from "../lambda/chat-context.js";
import type { ChatMessage } from "../workflows/transcript.js";

export type { ChannelMessage, Scanned, ThreadSummary };

/** The poster's chat-context operations, already bound to the bot, chat and caller identity. */
export interface ChatPosterClient {
  listThreads(request: { limit: number }): Promise<{ threads: ThreadSummary[]; scanned: Scanned }>;
  readChannel(request: {
    limit: number;
    before?: string | undefined;
  }): Promise<{ messages: ChannelMessage[]; scanned: Scanned }>;
  /** Returns up to `limit` messages older than `before`, oldest first. */
  readThread(request: {
    threadId: string;
    limit: number;
    before?: string | undefined;
  }): Promise<{ messages: ChatMessage[]; scanned: Scanned }>;
}
