import type { Logger, Message, Thread } from "chat";
import type { AccessKind } from "./access-entries.js";
import type { AccessRequest, AccessRequestStore, RequestKind } from "./access-request-store.js";
import {
  type AdminChannel,
  APPROVE_EMOJI,
  DENY_EMOJI,
  type DirectMessenger,
  lookupAdminId,
} from "./admin-channel.js";
import { scopedChatPrefix } from "./connection-paths.js";
import { parseDestinations, proposeDestinationName } from "./destinations.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const REQUESTED_TEXT = "I've asked my admin for access. I'll let you know when they answer.";
export const PENDING_TEXT = "My admin hasn't answered yet. I'll let you know when they do.";
export const UNREACHABLE_TEXT = "I couldn't reach my admin.";

const UNKNOWN_NAME = "(unknown)";
const DM_TITLE = "direct message";
const NAME_MAX = 80;
const SUMMARY_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const oneLine = (value: string | undefined, max = NAME_MAX) =>
  value?.replace(/\s+/g, " ").trim().slice(0, max) || UNKNOWN_NAME;

export interface AccessRequesterDeps {
  bot: Bot;
  params: ParameterStore;
  store: AccessRequestStore;
  channel: AdminChannel;
  messenger: DirectMessenger;
  logger: Pick<Logger, "info" | "error">;
}

export type AccessRequester = (
  kind: AccessKind,
  thread: Thread<ThreadMetadata>,
  message: Message,
) => Promise<boolean>;

async function chatTitle(thread: Thread<ThreadMetadata>): Promise<string | undefined> {
  try {
    const { channelName } = await thread.adapter.fetchThread(thread.id);
    if (channelName) return oneLine(channelName);
  } catch {}
  return undefined;
}

type RequestFields = Omit<AccessRequest, "id" | "createdAt">;

export type RaiseOutcome = "raised" | "pending" | "limited" | "unreachable";

export interface RequestSpec {
  kind: RequestKind;
  subjectId: string;
  /** Runs once the subject's slot and the rate limit are secured; returns what to store and the DM body. */
  describe: () => Promise<{ fields: Omit<RequestFields, "kind" | "subjectId">; lines: string[] }>;
}

/** Opens a request for a subject: one pending slot, a rate limit, the stored record and the admin DM. */
function createRequestRaiser({
  bot,
  store,
  channel,
  messenger,
  logger,
}: Omit<AccessRequesterDeps, "params">) {
  const where = { bot: bot.name, platform: bot.platform };
  return async (adminId: string, { kind, subjectId, describe }: RequestSpec) => {
    if (!(await store.claimSubject(kind, subjectId))) return "pending";
    if (await store.overLimit()) {
      await store.releaseSubject(kind, subjectId);
      logger.info("access request limit reached; dropping request", { ...where, kind, subjectId });
      return "limited";
    }
    const { fields, lines } = await describe();
    const request = await store.create({ kind, subjectId, ...fields });
    await store.recordRequest();
    await store.linkSubject(request);

    const denyVerb = kind === "mcp" ? "deny" : "deny and block";
    const text = [
      `Access request ${request.id}`,
      `Bot: ${bot.name}`,
      ...lines,
      `React ${APPROVE_EMOJI} to approve, or ${DENY_EMOJI} to ${denyVerb}.`,
      ...(channel.commands ? [`Or reply /approve ${request.id} or /deny ${request.id}.`] : []),
      `Expires in ${store.ttlMs / DAY_MS} days.`,
    ].join("\n");
    try {
      await store.linkMessage(await channel.notify(messenger, adminId, text), request);
    } catch (error) {
      await store.remove(request);
      await store.releaseSubject(kind, subjectId);
      logger.error("failed to notify admin of access request", {
        ...where,
        kind,
        subjectId,
        requestId: request.id,
        error,
      });
      return "unreachable";
    }
    return "raised";
  };
}

export function createAccessRequester(deps: AccessRequesterDeps): AccessRequester {
  const { bot, params, store } = deps;
  const raise = createRequestRaiser(deps);
  return async (kind, thread, message) => {
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return false;

    const chatId = thread.channelId.slice(bot.platform.length + 1);
    const requesterId = message.author.userId;
    const requesterName = oneLine(message.author.fullName || message.author.userName);
    const subjectId = kind === "chat" ? chatId : requesterId;

    const outcome = await raise(adminId, {
      kind,
      subjectId,
      describe: async () => {
        const title = thread.isDM ? DM_TITLE : await chatTitle(thread);
        const destinationName =
          kind === "chat"
            ? proposeDestinationName(
                parseDestinations(await params.getByPath(scopedChatPrefix(bot.platform))),
                chatId,
                title,
              )
            : undefined;
        return {
          fields: {
            subjectName: kind === "chat" ? (title ?? UNKNOWN_NAME) : requesterName,
            ...(destinationName ? { alias: destinationName } : {}),
            threadId: thread.id,
          },
          lines: [
            `Kind: ${kind}`,
            `Requester: ${requesterName} (${requesterId})`,
            `Chat: ${title ?? UNKNOWN_NAME} (${chatId})`,
            ...(destinationName ? [`Destination: ${destinationName}`] : []),
          ],
        };
      },
    });
    if (outcome === "pending") {
      if (await store.claimPendingNotice(kind, subjectId)) await thread.post(PENDING_TEXT);
    } else if (outcome === "unreachable") {
      await thread.post(UNREACHABLE_TEXT);
    } else if (outcome === "raised") {
      await thread.post(REQUESTED_TEXT);
    }
    return true;
  };
}

export interface McpApprovalInput {
  name: string;
  fingerprint: string;
  summary: string;
  threadId: string;
  messageId: string;
  suspended?: boolean;
}

/** Asks the admin to approve an MCP server definition; `undefined` when the bot has no admin. */
export type McpApprovalRequester = (input: McpApprovalInput) => Promise<RaiseOutcome | undefined>;

export function createMcpApprovalRequester(deps: AccessRequesterDeps): McpApprovalRequester {
  const { bot, params } = deps;
  const raise = createRequestRaiser(deps);
  return async ({ name, fingerprint, summary, threadId, messageId, suspended }) => {
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return undefined;
    const oneLineSummary = oneLine(summary, SUMMARY_MAX);
    return raise(adminId, {
      kind: "mcp",
      subjectId: `${name}:${fingerprint}`,
      describe: async () => ({
        fields: {
          subjectName: name,
          threadId,
          messageId,
          summary: oneLineSummary,
          ...(suspended ? { suspended } : {}),
        },
        lines: [
          "Kind: mcp",
          `Repository: ${bot.repo}`,
          `Server: ${oneLine(name)}`,
          `Summary: ${oneLineSummary}`,
        ],
      }),
    });
  };
}
