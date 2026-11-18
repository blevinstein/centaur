import type { Logger, ReactionEvent, SlashCommandEvent } from "chat";
import { approvedParameter, blockedParameter, encodeEntry } from "./access-entries.js";
import {
  type AccessRequest,
  type AccessRequestStore,
  normalizeId,
  type Verdict,
} from "./access-request-store.js";
import { type AdminChannel, lookupAdminId } from "./admin-channel.js";
import { recordChatAlias, slugAlias } from "./chat-aliases.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const COMMAND_VERDICTS: Record<string, Verdict> = {
  "/approve": "approve",
  "/deny": "deny",
};

export const APPROVED_TEXT: Record<AccessRequest["kind"], string> = {
  chat: "This chat is approved. Each person still needs approval to talk to me.",
  user: "You're approved. Send your message again.",
};

export const COMMAND_REPLIES = {
  approve: (request: AccessRequest, alias?: string) =>
    `Approved ${request.kind} ${request.id}${alias ? ` as "${alias}"` : ""}.`,
  deny: (request: AccessRequest) => `Denied and blocked ${request.kind} ${request.id}.`,
  unknown: "Unknown or expired request.",
  handled: "That request was already handled.",
  usage: "Usage: /approve <id> or /deny <id>",
} as const;

export type DecisionOutcome =
  | { status: "applied"; request: AccessRequest; alias?: string | undefined }
  | { status: "unknown" | "handled" };

export interface AccessDecisionsDeps {
  bot: Bot;
  params: ParameterStore;
  store: AccessRequestStore;
  channel: AdminChannel;
  invalidateAccess: () => void;
  postToThread: (threadId: string, text: string) => Promise<unknown>;
  logger: Pick<Logger, "info" | "warn">;
}

export function createAccessDecisions({
  bot,
  params,
  store,
  channel,
  invalidateAccess,
  postToThread,
  logger,
}: AccessDecisionsDeps) {
  const where = { bot: bot.name, platform: bot.platform };

  const isAdmin = async (userId: string) => userId === (await lookupAdminId(params, bot.platform));

  const apply = async (request: AccessRequest, verdict: Verdict) => {
    const parameter = verdict === "approve" ? approvedParameter : blockedParameter;
    const alias =
      verdict === "approve" && request.kind === "chat"
        ? await recordChatAlias(
            params,
            request.subjectId,
            request.alias ?? slugAlias(undefined, request.subjectId),
          )
        : undefined;
    await params.put(
      parameter(bot.name, request.kind, request.subjectId),
      encodeEntry({ name: request.subjectName, alias }),
    );
    invalidateAccess();
    return alias;
  };

  const resolve = async (requestId: string, verdict: Verdict): Promise<DecisionOutcome> => {
    const request = await store.read(requestId);
    if (!request) return { status: "unknown" };
    if (!(await store.claimDecision(request.id, verdict))) return { status: "handled" };
    let alias: string | undefined;
    try {
      alias = await apply(request, verdict);
    } catch (error) {
      await store.releaseDecision(request.id);
      throw error;
    }
    logger.info("access request decided", {
      ...where,
      requestId: request.id,
      kind: request.kind,
      subjectId: request.subjectId,
      verdict,
    });
    if (verdict === "approve") {
      try {
        await postToThread(request.threadId, APPROVED_TEXT[request.kind]);
      } catch (error) {
        logger.warn("failed to confirm approval to requester", {
          ...where,
          requestId: request.id,
          error,
        });
      }
    }
    return { status: "applied", request, alias };
  };

  return {
    async fromReaction(
      event: Pick<ReactionEvent, "added" | "rawEmoji" | "messageId"> & {
        user: { userId: string };
        thread: { isDM: boolean };
      },
    ) {
      const verdict = event.added ? channel.verdictForReaction(event.rawEmoji) : undefined;
      if (!verdict || !event.thread.isDM) return;
      const requestId = await store.requestIdForMessage(event.messageId);
      if (!requestId) return;
      if (!(await isAdmin(event.user.userId))) {
        logger.warn("ignoring access decision from a non-admin", {
          ...where,
          requestId,
          userId: event.user.userId,
        });
        return;
      }
      await resolve(requestId, verdict);
    },

    async fromCommand(
      event: Pick<SlashCommandEvent, "command" | "text"> & {
        user: { userId: string };
        isDM: boolean;
      },
    ): Promise<string | undefined> {
      const verdict = COMMAND_VERDICTS[event.command];
      if (!verdict || !event.isDM || !(await isAdmin(event.user.userId))) return undefined;
      const requestId = normalizeId(event.text);
      if (!requestId) return COMMAND_REPLIES.usage;
      const outcome = await resolve(requestId, verdict);
      return outcome.status === "applied"
        ? COMMAND_REPLIES[verdict](outcome.request, outcome.alias)
        : COMMAND_REPLIES[outcome.status];
    },
  };
}

export type AccessDecisions = ReturnType<typeof createAccessDecisions>;
