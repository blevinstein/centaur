import type { Scanned } from "../../src/mcp/chat-poster-client.js";
import { createPosterChatClient } from "../../src/mcp/poster-chat-client.js";
import { createPosterClient } from "../../src/workflows/aws.js";
import { scannedRange } from "./chat-context-fixtures.js";
import { CURRENT, type channelMessage, summary } from "./chat-server-fixtures.js";
import { createFakeAws, message } from "./workflow-fixtures.js";

export const BOT = "sprout";
export const CHAT = "-1001234567890";

export const storedThread = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      ...message(String(n), `stored ${n}`),
      sentAt: new Date(Date.UTC(2026, 10, 17, 10, n)).toISOString(),
    };
  });

export function fakePosterChat(
  data: {
    stored?: ReturnType<typeof storedThread>;
    channel?: ReturnType<typeof channelMessage>[];
    scanned?: Scanned;
  } = {},
) {
  const scanned = data.scanned ?? scannedRange(3, false);
  const aws = createFakeAws((request) => {
    switch (request.operation) {
      case "list-threads":
        return { threads: [summary(CURRENT), summary("telegram:-1001234567890:9")], scanned };
      case "read-channel":
        return { messages: data.channel ?? [], scanned };
      case "read":
        return { messages: data.stored ?? [] };
      default:
        throw new Error(`unexpected ${request.operation}`);
    }
  });
  let tokens = 0;
  const client = createPosterChatClient(aws.poster, async () => `jwt-${++tokens}`, {
    bot: BOT,
    threadId: CURRENT,
  });
  return { client, requests: aws.requests };
}

/** An `execFile` rejection: the message carries the command line (function name, payload path) before stderr. */
export const execFailure = (stderr: string, code?: string) =>
  Object.assign(
    new Error(
      `Command failed: aws lambda invoke --function-name poster-fn --payload file:///tmp/centaur-invoke-x/payload.json\n${stderr}`,
    ),
    {
      stderr,
      ...(code && { code }),
    },
  );

export const posterFailingWith = (error: Error) =>
  createPosterClient("poster-fn", async () => {
    throw error;
  });
