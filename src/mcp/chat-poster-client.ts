import type {
  ChannelMessage,
  ChatMessage,
  Scanned,
  SearchChatResult,
  ThreadSummary,
} from "../poster-contract.js";

export type { ChannelMessage, Scanned, SearchChatResult, ThreadSummary };

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
  searchChat(request: {
    query: string;
    limit: number;
    after?: string | undefined;
    before?: string | undefined;
  }): Promise<SearchChatResult>;
}
