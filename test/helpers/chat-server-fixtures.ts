import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ChannelMessage,
  ChatPosterClient,
  Scanned,
  ThreadSummary,
} from "../../src/mcp/chat-poster-client.js";
import { type ChatServerDeps, createChatServer } from "../../src/mcp/chat-server.js";
import { scannedRange } from "./chat-context-fixtures.js";
import { message } from "./workflow-fixtures.js";

export const CURRENT = "telegram:-1001234567890:7";
export const OTHER = "telegram:-1001234567890:9";
export const THIRD = "telegram:-1001234567890:11";

export const summary = (
  threadId: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  threadId,
  title: `title of ${threadId.split(":").at(-1)}`,
  lastActivity: "2026-11-17T10:00:00.000Z",
  messageCount: 3,
  participants: ["Sam"],
  snippet: "hello",
  ...overrides,
});

export const channelMessage = (
  id: string,
  threadId: string,
  text = `text ${id}`,
): ChannelMessage => ({
  ...message(id, text),
  threadId,
});

export function fakeChatClient(
  data: {
    threads?: ThreadSummary[];
    channel?: ChannelMessage[];
    thread?: ReturnType<typeof message>[];
    scanned?: Scanned;
    failure?: unknown;
  } = {},
) {
  const scanned = data.scanned ?? scannedRange(null, true);
  const calls: { op: string; request: unknown }[] = [];
  const client: ChatPosterClient = {
    async listThreads(request) {
      calls.push({ op: "listThreads", request });
      if (data.failure !== undefined) throw data.failure;
      return { threads: data.threads ?? [], scanned };
    },
    async readChannel(request) {
      calls.push({ op: "readChannel", request });
      if (data.failure !== undefined) throw data.failure;
      return { messages: data.channel ?? [], scanned };
    },
    async readThread(request) {
      calls.push({ op: "readThread", request });
      if (data.failure !== undefined) throw data.failure;
      return { messages: data.thread ?? [], scanned };
    },
  };
  return { client, calls };
}

export async function connectChatServer(
  client: ChatPosterClient,
  overrides: Partial<ChatServerDeps> = {},
) {
  const server = createChatServer({
    client,
    currentThreadId: CURRENT,
    maxThreads: 20,
    maxMessages: 50,
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const [part] = result.content as { type: string; text: string }[];
    return { text: part?.text ?? "", isError: result.isError === true };
  };
  return { mcp, call, close: () => mcp.close() };
}
