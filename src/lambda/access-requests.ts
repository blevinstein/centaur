import type { Logger, Message, Thread } from "chat";
import type { AccessKind } from "./access-entries.js";
import {
  type AccessRequest,
  type AccessRequestStore,
  blocksOnDeny,
  type RequestKind,
} from "./access-request-store.js";
import {
  type AdminChannel,
  APPROVE_EMOJI,
  DENY_EMOJI,
  type DirectMessenger,
  lookupAdminId,
} from "./admin-channel.js";
import { recipientsFor } from "./approvers.js";
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
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/** Raises one request per kind and sends the sender a single reply; `false` when the bot has no admin. */
export type AccessRequester = (
  kinds: readonly AccessKind[],
  thread: Thread<ThreadMetadata>,
  message: Message,
) => Promise<boolean>;

const SCOPE_LINES: Record<AccessKind, string> = {
  chat: "Approving admits this chat for every user already approved.",
  user: "Approving admits this user in every approved chat of this bot.",
};

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

/** Opens a request for a subject: one pending slot, a rate limit, the stored record and a DM to each recipient. */
function createRequestRaiser({
  bot,
  params,
  store,
  channel,
  messenger,
  logger,
}: AccessRequesterDeps) {
  const where = { bot: bot.name, platform: bot.platform };
  /** Takes the subject's pending slot, replacing one left pointing at a decided or missing request. */
  const claimSlot = async (kind: RequestKind, subjectId: string) => {
    if (await store.claimSubject(kind, subjectId)) return true;
    if (!(await store.isSubjectSlotStale(kind, subjectId))) return false;
    await store.releaseSubject(kind, subjectId);
    return store.claimSubject(kind, subjectId);
  };
  return async (adminId: string, { kind, subjectId, describe }: RequestSpec) => {
    const recipients = await recipientsFor(params, bot, kind, adminId);
    if (!(await claimSlot(kind, subjectId))) return "pending";
    let request: AccessRequest | undefined;
    let outcome: RaiseOutcome = "unreachable";
    try {
      if (await store.overLimit()) {
        logger.info("access request limit reached; dropping request", {
          ...where,
          kind,
          subjectId,
        });
        outcome = "limited";
        return outcome;
      }
      const { fields, lines } = await describe();
      request = await store.create({ kind, subjectId, ...fields });
      await store.recordRequest();
      await store.linkSubject(request);

      const denyVerb = blocksOnDeny(kind) ? "deny and block" : "deny";
      const text = [
        `Access request ${request.id}`,
        `Bot: ${bot.name}`,
        ...lines,
        `React ${APPROVE_EMOJI} to approve, or ${DENY_EMOJI} to ${denyVerb}.`,
        ...(channel.commands ? [`Or reply /approve ${request.id} or /deny ${request.id}.`] : []),
        `Expires in ${store.ttlMs / DAY_MS} days.`,
      ].join("\n");
      let delivered = 0;
      let lastError: unknown;
      for (const userId of recipients) {
        try {
          await store.linkMessage(await channel.notify(messenger, userId, text), request);
          delivered++;
        } catch (error) {
          lastError = error;
          logger.warn("failed to notify a recipient of access request", { ...where, kind });
        }
      }
      if (delivered > 0) {
        outcome = "raised";
      } else {
        logger.error("failed to notify admin of access request", {
          ...where,
          kind,
          subjectId,
          requestId: request.id,
          error: lastError,
        });
      }
      return outcome;
    } finally {
      if (outcome !== "raised") {
        if (request) await store.remove(request);
        await store.releaseSubject(kind, subjectId);
      }
    }
  };
}

export function createAccessRequester(deps: AccessRequesterDeps): AccessRequester {
  const { bot, params, store } = deps;
  const raise = createRequestRaiser(deps);
  return async (kinds, thread, message) => {
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return false;

    const chatId = thread.channelId.slice(bot.platform.length + 1);
    const requesterId = message.author.userId;
    const requesterName = oneLine(message.author.fullName || message.author.userName);
    const subjectIdOf = (kind: AccessKind) => (kind === "chat" ? chatId : requesterId);

    const outcomes: [AccessKind, RaiseOutcome][] = [];
    for (const kind of kinds) {
      const outcome = await raise(adminId, {
        kind,
        subjectId: subjectIdOf(kind),
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
              SCOPE_LINES[kind],
            ],
          };
        },
      });
      outcomes.push([kind, outcome]);
      if (outcome === "limited") break;
    }

    const has = (wanted: RaiseOutcome) => outcomes.some(([, outcome]) => outcome === wanted);
    if (has("raised")) {
      await thread.post(REQUESTED_TEXT);
    } else if (has("unreachable")) {
      await thread.post(UNREACHABLE_TEXT);
    } else {
      const noticed = await Promise.all(
        outcomes
          .filter(([, outcome]) => outcome === "pending")
          .map(([kind]) => store.claimPendingNotice(kind, subjectIdOf(kind))),
      );
      if (noticed.includes(true)) await thread.post(PENDING_TEXT);
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

export interface ApproverRequestInput {
  userId: string;
  name: string | undefined;
  threadId: string;
}

/** Asks the admin to make a user an approver; `undefined` when the bot has no admin. */
export type ApproverRequester = (input: ApproverRequestInput) => Promise<RaiseOutcome | undefined>;

export function createApproverRequester(deps: AccessRequesterDeps): ApproverRequester {
  const { bot, params } = deps;
  const raise = createRequestRaiser(deps);
  return async ({ userId, name, threadId }) => {
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return undefined;
    const requesterName = oneLine(name);
    return raise(adminId, {
      kind: "approver",
      subjectId: userId,
      describe: async () => ({
        fields: { subjectName: requesterName, threadId },
        lines: [
          "Kind: approver",
          `Platform: ${bot.platform}`,
          `Requester: ${requesterName} (${userId})`,
        ],
      }),
    });
  };
}
