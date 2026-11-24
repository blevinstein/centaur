import type { Logger, StateAdapter } from "chat";
import { z } from "zod";
import { slug } from "../config/index.js";
import { createAccessRequestStore } from "./access-request-store.js";
import { createMcpApprovalRequester } from "./access-requests.js";
import { ADMIN_CHANNELS, type DirectMessenger } from "./admin-channel.js";
import { mcpApprovalParameter } from "./connection-paths.js";
import type { OidcVerifier } from "./oidc.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, requireBound } from "./registry.js";

export const MCP_APPROVAL_SERVERS_MAX = 20;
export const MCP_SUMMARY_MAX = 2000;

const field = z.string().min(1);

export const mcpApprovalsRequestSchema = z
  .strictObject({
    operation: z.literal("mcp-approvals"),
    token: field,
    bot: slug,
    threadId: field.optional(),
    messageId: field.optional(),
    servers: z
      .array(
        z.strictObject({
          name: field,
          fingerprint: field,
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

export interface McpApprovalsDeps {
  params: ParameterStore;
  oidc: OidcVerifier;
  open: (
    botName: string,
    threadId: string,
  ) => Promise<{ bot: Bot; messenger: DirectMessenger; state: StateAdapter }>;
  /** The bot's state without a thread or a platform, for reads that never ask. */
  openBotState: (botName: string) => Promise<StateAdapter>;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Reads each server definition's decision: a stored approval, then a recorded denial, else a
 * request to the admin (raised once per definition). Without a thread the call is read-only: it
 * never asks, and answers `pending` where it would have. Failures throw, so the caller never reads
 * an error as an approval.
 */
export function createMcpApprovals({ params, oidc, open, openBotState, logger }: McpApprovalsDeps) {
  return async (request: McpApprovalsRequest): Promise<McpApprovalsResult> => {
    await requireBound(params, oidc, request.token, request.bot);
    const { threadId, messageId, suspend } = request;
    const thread =
      threadId !== undefined && messageId !== undefined
        ? { threadId, messageId, ...(await open(request.bot, threadId)) }
        : undefined;
    const store = createAccessRequestStore(thread?.state ?? (await openBotState(request.bot)));
    const requestApproval =
      thread &&
      createMcpApprovalRequester({
        bot: thread.bot,
        params,
        store,
        channel: ADMIN_CHANNELS[thread.bot.platform],
        messenger: thread.messenger,
        logger,
      });

    const statusOf = async (
      server: McpApprovalsRequest["servers"][number],
    ): Promise<McpApprovalStatus> => {
      const subjectId = `${server.name}:${server.fingerprint}`;
      if (
        (await params.get(mcpApprovalParameter(request.bot, server.name, server.fingerprint))) !==
        undefined
      ) {
        return "approved";
      }
      if (await store.isDenied("mcp", subjectId)) return "denied";
      if (!thread || !requestApproval) return "pending";
      const outcome = await requestApproval({
        ...server,
        threadId: thread.threadId,
        messageId: thread.messageId,
        ...(suspend ? { suspended: true } : {}),
      });
      if (outcome === undefined) {
        logger.warn("no admin to approve an MCP server; treating it as denied", {
          bot: thread.bot.name,
          platform: thread.bot.platform,
        });
        return "denied";
      }
      if (outcome === "pending" && suspend) {
        await store.updatePending(subjectId, {
          threadId: thread.threadId,
          messageId: thread.messageId,
          suspended: true,
        });
      }
      return "pending";
    };

    const servers: Record<string, McpApprovalStatus> = {};
    for (const server of request.servers) servers[server.name] = await statusOf(server);
    return { servers };
  };
}
