import type { Logger, StateAdapter } from "chat";
import type {
  McpApprovalStatus,
  McpApprovalsRequest,
  McpApprovalsResult,
} from "../poster-contract.js";
import type { SelfIdentity } from "../self-identity.js";
import { createAccessRequestStore } from "./access-request-store.js";
import { createMcpApprovalRequester } from "./access-requests.js";
import { ADMIN_CHANNELS, type DirectMessenger } from "./admin-channel.js";
import {
  type ApprovalReaction,
  type ApprovalState,
  showApprovalState,
} from "./approval-reactions.js";
import { mcpApprovalParameter } from "./connection-paths.js";
import type { RepositoryDispatcher } from "./github.js";
import { dispatchMessage } from "./message-handler.js";
import type { OidcVerifier } from "./oidc.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, requireBound } from "./registry.js";
import { withSelfIdentity } from "./self-identity.js";

export interface McpApprovalsDeps {
  params: ParameterStore;
  oidc: OidcVerifier;
  open: (
    botName: string,
    threadId: string,
  ) => Promise<{
    bot: Bot;
    messenger: DirectMessenger;
    state: StateAdapter;
    adapter: ApprovalReaction["adapter"];
    /** Reads the bot's identity for the resume dispatch; the dispatch omits it when absent. */
    identify?: () => Promise<SelfIdentity | undefined>;
  }>;
  /** The bot's state without a thread or a platform, for reads that never ask. */
  openBotState: (botName: string) => Promise<StateAdapter>;
  dispatcher: RepositoryDispatcher;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Reads each server definition's decision: a stored approval, then a recorded denial, else a
 * request to the admin (raised once per definition). Without a thread the call is read-only: it
 * never asks, and answers `pending` where it would have. Failures throw, so the caller never reads
 * an error as an approval.
 *
 * A `suspend` call hands the wake-up to the decision handler, which re-dispatches the thread when
 * it decides a request marked suspended. A decision that landed before the mark (already in when
 * the call reads, or recorded while the call marks the request) is invisible to that handler, so
 * the call re-dispatches the thread itself, once however many servers were decided. A decision
 * the handler also dispatched for yields a second resume turn, which finds nothing pending and
 * exits like any empty turn. A failed dispatch throws.
 */
export function createMcpApprovals({
  params,
  oidc,
  open,
  openBotState,
  dispatcher,
  logger,
}: McpApprovalsDeps) {
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

    const decisionOf = async (
      server: McpApprovalsRequest["servers"][number],
    ): Promise<Exclude<McpApprovalStatus, "pending"> | undefined> => {
      if (
        (await params.get(mcpApprovalParameter(request.bot, server.name, server.fingerprint))) !==
        undefined
      ) {
        return "approved";
      }
      return (await store.isDenied("mcp", `${server.name}:${server.fingerprint}`))
        ? "denied"
        : undefined;
    };

    let resume = false;
    const statusOf = async (
      server: McpApprovalsRequest["servers"][number],
    ): Promise<McpApprovalStatus> => {
      const subjectId = `${server.name}:${server.fingerprint}`;
      const decided = await decisionOf(server);
      if (decided) {
        resume ||= Boolean(suspend);
        return decided;
      }
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
      if (suspend && (outcome === "pending" || outcome === "raised")) {
        if (outcome === "pending") {
          await store.updatePending(subjectId, {
            threadId: thread.threadId,
            messageId: thread.messageId,
            suspended: true,
          });
        }
        const show = (state: ApprovalState) =>
          showApprovalState({
            adapter: thread.adapter,
            bot: thread.bot,
            threadId: thread.threadId,
            messageId: thread.messageId,
            state,
            logger,
          });
        await show("waiting");
        const late = outcome === "pending" ? await decisionOf(server) : undefined;
        if (late) {
          await show(late);
          resume = true;
          return late;
        }
      }
      return "pending";
    };

    const servers: Record<string, McpApprovalStatus> = {};
    for (const server of request.servers) servers[server.name] = await statusOf(server);
    if (resume && thread) {
      await dispatchMessage(
        thread.identify ? withSelfIdentity(dispatcher, thread.identify) : dispatcher,
        thread.bot,
        thread.threadId,
        thread.messageId,
      );
    }
    return { servers };
  };
}
