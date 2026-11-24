import type { Logger, StateAdapter } from "chat";
import { z } from "zod";
import { slug } from "../config/index.js";
import { mcpApprovalParameter } from "./access-decisions.js";
import { createAccessRequestStore } from "./access-request-store.js";
import { createMcpApprovalRequester } from "./access-requests.js";
import { ADMIN_CHANNELS, type DirectMessenger } from "./admin-channel.js";
import type { OidcVerifier } from "./oidc.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, requireBound } from "./registry.js";

export const MCP_APPROVAL_SERVERS_MAX = 20;
export const MCP_SUMMARY_MAX = 2000;

const field = z.string().min(1);

export const mcpApprovalsRequestSchema = z.strictObject({
  operation: z.literal("mcp-approvals"),
  token: field,
  bot: slug,
  threadId: field,
  messageId: field,
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
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Reads each server definition's decision: a stored approval, then a recorded denial, else a
 * request to the admin (raised once per definition). Failures throw, so the caller never reads
 * an error as an approval.
 */
export function createMcpApprovals({ params, oidc, open, logger }: McpApprovalsDeps) {
  return async (request: McpApprovalsRequest): Promise<McpApprovalsResult> => {
    await requireBound(params, oidc, request.token, request.bot);
    const { bot, messenger, state } = await open(request.bot, request.threadId);
    const store = createAccessRequestStore(state);
    const requestApproval = createMcpApprovalRequester({
      bot,
      params,
      store,
      channel: ADMIN_CHANNELS[bot.platform],
      messenger,
      logger,
    });
    const { threadId, messageId, suspend } = request;

    const statusOf = async (
      server: McpApprovalsRequest["servers"][number],
    ): Promise<McpApprovalStatus> => {
      const subjectId = `${server.name}:${server.fingerprint}`;
      if ((await params.get(mcpApprovalParameter(bot.name, subjectId))) !== undefined) {
        return "approved";
      }
      if (await store.isDenied(subjectId)) return "denied";
      const outcome = await requestApproval({
        ...server,
        threadId,
        messageId,
        ...(suspend ? { suspended: true } : {}),
      });
      if (outcome === undefined) {
        logger.warn("no admin to approve an MCP server; treating it as denied", {
          bot: bot.name,
          platform: bot.platform,
        });
        return "denied";
      }
      if (outcome === "pending" && suspend) {
        await store.updatePending(subjectId, { threadId, messageId, suspended: true });
      }
      return "pending";
    };

    const servers: Record<string, McpApprovalStatus> = {};
    for (const server of request.servers) servers[server.name] = await statusOf(server);
    return { servers };
  };
}
