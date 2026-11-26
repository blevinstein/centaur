import { z } from "zod";
import { slug } from "./config/index.js";

export const UNREACT_MAX_MESSAGES = 50;
export const LIST_THREADS_MAX = 50;
export const READ_CHANNEL_MAX = 200;
export const MESSAGE_TEXT_MAX = 4000;
export const MCP_APPROVAL_SERVERS_MAX = 20;
export const MCP_SUMMARY_MAX = 2000;

/** The operations whose token is optional while `REQUIRE_POSTER_TOKEN` is off; the others always take one. */
export const OPTIONAL_TOKEN_OPERATIONS: ReadonlySet<string> = new Set([
  "post",
  "unreact",
  "start-thread",
  "get-mcp-policy",
]);

const nonEmpty = z.string().min(1);
const count = (max: number) => z.number().int().positive().max(max);

const target = {
  token: nonEmpty,
  bot: slug,
  chatId: nonEmpty,
  /** The thread the turn was dispatched for; the poster derives the one chat the turn may read from it. */
  threadId: nonEmpty,
  includeBots: z.boolean().optional(),
};

export const listThreadsRequestSchema = z.strictObject({
  operation: z.literal("list-threads"),
  ...target,
  limit: count(LIST_THREADS_MAX).optional(),
});

export const readChannelRequestSchema = z.strictObject({
  operation: z.literal("read-channel"),
  ...target,
  limit: count(READ_CHANNEL_MAX).optional(),
  /** Only messages sent before this instant (ISO 8601), for paging backwards. */
  before: z.iso.datetime().optional(),
});

export const threadSummarySchema = z.object({
  threadId: z.string(),
  title: z.string(),
  lastActivity: z.string(),
  messageCount: z.number().int(),
  participants: z.array(z.string()),
  snippet: z.string(),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  fromBot: z.boolean(),
  text: z.string(),
  attachments: z.array(z.string()),
  sentAt: z.string(),
});

export const channelMessageSchema = chatMessageSchema.extend({ threadId: z.string() });

/** The range a read examined: the oldest message seen, and whether nothing older was left to see. */
export const scannedSchema = z.object({
  oldest: z.string().nullable(),
  exhausted: z.boolean(),
});

export const listThreadsResultSchema = z.object({
  threads: z.array(threadSummarySchema),
  scanned: scannedSchema,
});
export const readChannelResultSchema = z.object({
  messages: z.array(channelMessageSchema),
  scanned: scannedSchema,
});

export type ListThreadsRequest = z.input<typeof listThreadsRequestSchema>;
export type ReadChannelRequest = z.input<typeof readChannelRequestSchema>;
export type Scanned = z.infer<typeof scannedSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
export type ListThreadsResult = z.infer<typeof listThreadsResultSchema>;
export type ReadChannelResult = z.infer<typeof readChannelResultSchema>;

export const mcpApprovalsRequestSchema = z
  .strictObject({
    operation: z.literal("mcp-approvals"),
    token: nonEmpty,
    bot: slug,
    threadId: nonEmpty.optional(),
    messageId: nonEmpty.optional(),
    servers: z
      .array(
        z.strictObject({
          name: nonEmpty,
          fingerprint: nonEmpty,
          summary: z.string().max(MCP_SUMMARY_MAX),
        }),
      )
      .min(1)
      .max(MCP_APPROVAL_SERVERS_MAX),
    suspend: z.boolean().optional(),
  })
  .refine(({ threadId, messageId }) => (threadId === undefined) === (messageId === undefined), {
    message: "threadId and messageId must be given together",
    path: ["threadId"],
  })
  .refine(({ threadId, suspend }) => !suspend || threadId !== undefined, {
    message: "suspend requires threadId and messageId",
    path: ["suspend"],
  });

export type McpApprovalsRequest = z.infer<typeof mcpApprovalsRequestSchema>;
export const mcpApprovalsResultSchema = z.object({
  servers: z.record(z.string(), z.enum(["approved", "pending", "denied"])),
});
export type McpApprovalsResult = z.infer<typeof mcpApprovalsResultSchema>;
export type McpApprovalStatus = McpApprovalsResult["servers"][string];
