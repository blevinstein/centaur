import type { ChatMessage } from "../workflows/transcript.js";

export interface ThreadSummary {
  threadId: string;
  title: string;
  lastActivity: string;
  messageCount: number;
  participants: string[];
  snippet: string;
}

export interface ChannelMessage extends ChatMessage {
  threadId: string;
}

/** The poster's chat-context operations, already bound to the bot, chat and caller identity. */
export interface ChatPosterClient {
  listThreads(request: { limit: number }): Promise<{ threads: ThreadSummary[] }>;
  readChannel(request: {
    limit: number;
    before?: string | undefined;
  }): Promise<{ messages: ChannelMessage[] }>;
  /** Returns up to `limit` messages older than `before`, oldest first. */
  readThread(request: {
    threadId: string;
    limit: number;
    before?: string | undefined;
  }): Promise<{ messages: ChatMessage[] }>;
}
