import type { Logger, ReactionEvent, SlashCommandEvent } from "chat";
import { type AccessKind, encodeEntry } from "./access-entries.js";
import {
  type AccessRequest,
  type AccessRequestStore,
  blocksOnDeny,
  normalizeId,
  type Verdict,
} from "./access-request-store.js";
import { type AdminChannel, lookupAdminId } from "./admin-channel.js";
import {
  type DeciderRoles,
  isMember,
  loadApprovers,
  MAX_APPROVERS,
  mayDecide,
} from "./approvers.js";
import {
  approvedParameter,
  approverParameter,
  blockedParameter,
  mcpApprovalParameter,
  parseMcpApprovalKey,
} from "./connection-paths.js";
import { recordDestination, slugName } from "./destinations.js";
import type { RepositoryDispatcher } from "./github.js";
import { dispatchMessage } from "./message-handler.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const COMMAND_VERDICTS: Record<string, Verdict> = {
  "/approve": "approve",
  "/deny": "deny",
};

export const APPROVED_TEXT: Record<AccessRequest["kind"], string> = {
  chat: "This chat is approved. Each person still needs approval to talk to me.",
  user: "You're approved. Send your message again.",
  mcp: "The admin approved the MCP server. If I haven't carried on, ask again.",
  approver: "You're now an approver for this bot.",
};

export const DENIED_TEXT: Partial<Record<AccessRequest["kind"], string>> = {
  mcp: "The admin denied the MCP server. I'll carry on without it.",
  approver: "The admin declined your request to be an approver.",
};

export const COMMAND_REPLIES = {
  approve: (request: AccessRequest, destinationName?: string) =>
    `Approved ${request.kind} ${request.id}${destinationName ? ` as "${destinationName}"` : ""}.`,
  deny: (request: AccessRequest) =>
    `Denied${blocksOnDeny(request.kind) ? " and blocked" : ""} ${request.kind} ${request.id}.`,
  unknown: "Unknown or expired request.",
  adminOnly: "That request is for the admin to decide.",
  handled: "That request was already handled.",
  approverCap: `There are already ${MAX_APPROVERS} approvers; remove one first.`,
  usage: "Usage: /approve <id> or /deny <id>",
} as const;

export type DecisionOutcome =
  | { status: "applied"; request: AccessRequest; destinationName?: string | undefined }
  | { status: "refused"; reason: string }
  | { status: "unknown" | "handled" };

export interface AccessDecisionsDeps {
  bot: Bot;
  params: ParameterStore;
  store: AccessRequestStore;
  channel: AdminChannel;
  invalidateAccess: () => void;
  postToThread: (threadId: string, text: string) => Promise<unknown>;
  dispatcher: RepositoryDispatcher;
  logger: Pick<Logger, "info" | "warn">;
}

class DecisionRefused extends Error {}

interface Decision {
  request: AccessRequest;
  verdict: Verdict;
  approverId: string;
}

export function createAccessDecisions({
  bot,
  params,
  store,
  channel,
  invalidateAccess,
  postToThread,
  dispatcher,
  logger,
}: AccessDecisionsDeps) {
  const where = { bot: bot.name, platform: bot.platform };

  const rolesOf = async (userId: string): Promise<DeciderRoles> => ({
    userId,
    admin: await lookupAdminId(params, bot.platform),
    approvers: await loadApprovers(params, bot.name, bot.platform),
  });

  const findRequest = async (requestId: string) => {
    const request = await store.read(requestId);
    return request?.threadId.startsWith(`${bot.platform}:`) ? request : undefined;
  };

  /** A stranger is never told whether a request exists; a member refused for its kind is. */
  const authorize = async (
    userId: string,
    request: AccessRequest | undefined,
  ): Promise<"stranger" | "refused" | "allowed"> => {
    const roles = await rolesOf(userId);
    if (!isMember(roles)) return "stranger";
    return !request || mayDecide({ ...roles, kind: request.kind }) ? "allowed" : "refused";
  };

  const applyAccess = async ({ request, verdict }: Decision) => {
    const kind = request.kind as AccessKind;
    const parameter = verdict === "approve" ? approvedParameter : blockedParameter;
    const destinationName =
      verdict === "approve" && request.kind === "chat"
        ? await recordDestination(
            params,
            bot.platform,
            { chatId: request.subjectId, name: request.subjectName },
            request.alias ?? slugName(undefined, request.subjectId),
          )
        : undefined;
    await params.put(
      parameter(bot.name, bot.platform, kind, request.subjectId),
      encodeEntry({ name: request.subjectName, alias: destinationName }),
    );
    invalidateAccess();
    return destinationName;
  };

  const applyMcp = async ({ request, verdict, approverId }: Decision) => {
    if (verdict === "approve") {
      const { name, fingerprint } = parseMcpApprovalKey(request.subjectId);
      await params.put(
        mcpApprovalParameter(bot.name, name, fingerprint),
        JSON.stringify({ at: new Date().toISOString(), approver: approverId }),
      );
    } else {
      await store.recordDenial(request.kind, request.subjectId, approverId);
    }
    if (request.suspended && request.messageId) {
      await dispatchMessage(dispatcher, bot, request.threadId, request.messageId);
    }
    return undefined;
  };

  const applyApprover = async ({ request, verdict, approverId }: Decision) => {
    if (verdict === "deny") {
      await store.recordDenial(request.kind, request.subjectId, approverId);
      return undefined;
    }
    const approvers = await loadApprovers(params, bot.name, bot.platform);
    if (!approvers.has(request.subjectId) && approvers.size >= MAX_APPROVERS) {
      throw new DecisionRefused(COMMAND_REPLIES.approverCap);
    }
    await params.put(
      approverParameter(bot.name, bot.platform, request.subjectId),
      encodeEntry({ name: request.subjectName, approver: approverId }),
    );
    return undefined;
  };

  const appliers: Record<
    AccessRequest["kind"],
    (decision: Decision) => Promise<string | undefined>
  > = { chat: applyAccess, user: applyAccess, mcp: applyMcp, approver: applyApprover };

  const resolve = async (
    request: AccessRequest | undefined,
    verdict: Verdict,
    approverId: string,
  ): Promise<DecisionOutcome> => {
    if (!request) return { status: "unknown" };
    if (!(await store.claimDecision(request.id, verdict))) return { status: "handled" };
    let destinationName: string | undefined;
    try {
      destinationName = await appliers[request.kind]({ request, verdict, approverId });
    } catch (error) {
      await store.releaseDecision(request.id);
      if (error instanceof DecisionRefused) {
        logger.warn("access request refused", {
          ...where,
          requestId: request.id,
          reason: error.message,
        });
        return { status: "refused", reason: error.message };
      }
      throw error;
    }
    logger.info("access request decided", {
      ...where,
      requestId: request.id,
      kind: request.kind,
      subjectId: request.subjectId,
      verdict,
      approverId,
    });
    const reply = verdict === "approve" ? APPROVED_TEXT[request.kind] : DENIED_TEXT[request.kind];
    if (reply) {
      try {
        await postToThread(request.threadId, reply);
      } catch (error) {
        logger.warn(
          `failed to confirm ${verdict === "approve" ? "approval" : "denial"} to requester`,
          {
            ...where,
            requestId: request.id,
            error,
          },
        );
      }
    }
    return { status: "applied", request, destinationName };
  };

  return {
    async fromReaction(
      event: Pick<ReactionEvent, "added" | "rawEmoji" | "messageId"> & {
        user: { userId: string };
        thread: { isDM: boolean; channelId: string };
      },
    ) {
      const verdict = event.added ? channel.verdictForReaction(event.rawEmoji) : undefined;
      if (!verdict) return;
      const userId = event.user.userId;
      if (!event.thread.isDM) {
        logger.info("ignoring access reaction outside a direct message", { ...where, userId });
        return;
      }
      const requestId = await store.requestIdForMessage({
        channelId: event.thread.channelId,
        messageId: event.messageId,
      });
      if (!requestId) {
        logger.info("ignoring access reaction on a message with no linked request", {
          ...where,
          userId,
        });
        return;
      }
      const request = await findRequest(requestId);
      const access = await authorize(userId, request);
      if (access !== "allowed") {
        logger.warn(
          access === "stranger"
            ? "ignoring access decision from a non-admin"
            : "ignoring access decision on a request an approver may not decide",
          { ...where, requestId, userId },
        );
        return;
      }
      await resolve(request, verdict, userId);
    },

    async fromCommand(
      event: Pick<SlashCommandEvent, "command" | "text"> & {
        user: { userId: string };
        isDM: boolean;
      },
    ): Promise<string | undefined> {
      const verdict = COMMAND_VERDICTS[event.command];
      if (!verdict || !event.isDM) return undefined;
      const requestId = normalizeId(event.text);
      const request = requestId ? await findRequest(requestId) : undefined;
      const access = await authorize(event.user.userId, request);
      if (access === "stranger") return undefined;
      if (!requestId) return COMMAND_REPLIES.usage;
      if (access === "refused") return COMMAND_REPLIES.adminOnly;
      const outcome = await resolve(request, verdict, event.user.userId);
      if (outcome.status === "refused") return outcome.reason;
      return outcome.status === "applied"
        ? COMMAND_REPLIES[verdict](outcome.request, outcome.destinationName)
        : COMMAND_REPLIES[outcome.status];
    },
  };
}

export type AccessDecisions = ReturnType<typeof createAccessDecisions>;
