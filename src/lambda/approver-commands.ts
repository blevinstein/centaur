import type { Logger } from "chat";
import type { AccessResolver } from "./access.js";
import type { AccessRequestStore } from "./access-request-store.js";
import {
  type ApproverRequester,
  PENDING_TEXT,
  type RaiseOutcome,
  UNREACHABLE_TEXT,
} from "./access-requests.js";
import { lookupAdminId } from "./admin-channel.js";
import { loadApprovers, MAX_APPROVERS } from "./approvers.js";
import { approverParameter } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const APPROVER_COMMANDS = ["/approver"];

const APPROVER_MESSAGE = /^approver\s+(request|leave)\s*$/i;

export type ApproverSubcommand = "request" | "leave";

/** Parses `approver request` or `approver leave`; a Telegram `/approver <sub>` passes `approver <sub>`. */
export const parseApproverCommand = (text: string) =>
  APPROVER_MESSAGE.exec(text.trim())?.[1]?.toLowerCase() as ApproverSubcommand | undefined;

export const APPROVER_REPLIES = {
  notDirect: "Send that in a direct message to me.",
  noAdmin: "I have no admin on this platform, so I can't ask for approver access.",
  already: "You're already an approver.",
  denied: "The admin recently declined that request. You can ask again in a week.",
  full: `There are already ${MAX_APPROVERS} approvers.`,
  requested: "I've asked my admin to make you an approver. I'll let you know when they answer.",
  limited: "I've sent too many requests lately. Try again later.",
  left: "You're no longer an approver.",
  adminCannotLeave: "You're the admin, so you can't leave.",
  notApprover: "You aren't an approver.",
} as const;

const OUTCOME_REPLIES: Record<RaiseOutcome, string> = {
  raised: APPROVER_REPLIES.requested,
  pending: PENDING_TEXT,
  limited: APPROVER_REPLIES.limited,
  unreachable: UNREACHABLE_TEXT,
};

export interface ApproverCommandInput {
  sub: ApproverSubcommand;
  userId: string;
  name: string | undefined;
  isDM: boolean;
  threadId: string;
}

/** The reply for the sender, or undefined when the sender is not for this command to answer. */
export type ApproverCommand = (input: ApproverCommandInput) => Promise<string | undefined>;

export interface ApproverCommandDeps {
  bot: Bot;
  params: ParameterStore;
  store: Pick<AccessRequestStore, "isDenied">;
  resolveAccess: AccessResolver;
  requestApprover: ApproverRequester;
  logger: Pick<Logger, "info">;
}

export function createApproverCommand({
  bot,
  params,
  store,
  resolveAccess,
  requestApprover,
  logger,
}: ApproverCommandDeps): ApproverCommand {
  return async ({ sub, userId, name, isDM, threadId }) => {
    const [access, admin, approvers] = await Promise.all([
      resolveAccess(),
      lookupAdminId(params, bot.platform),
      loadApprovers(params, bot.name, bot.platform),
    ]);
    const isApprover = approvers.has(userId);
    const known = access.userIds.has(userId) || (sub === "leave" && isApprover);
    if (!known) return undefined;
    if (!isDM) return APPROVER_REPLIES.notDirect;

    if (sub === "leave") {
      if (userId === admin) return APPROVER_REPLIES.adminCannotLeave;
      if (!isApprover) return APPROVER_REPLIES.notApprover;
      await params.delete(approverParameter(bot.name, bot.platform, userId));
      logger.info("approver left", { bot: bot.name, platform: bot.platform, userId });
      return APPROVER_REPLIES.left;
    }

    if (!admin) return APPROVER_REPLIES.noAdmin;
    if (userId === admin || isApprover) return APPROVER_REPLIES.already;
    if (await store.isDenied("approver", userId)) return APPROVER_REPLIES.denied;
    if (approvers.size >= MAX_APPROVERS) return APPROVER_REPLIES.full;
    const outcome = await requestApprover({ userId, name, threadId });
    return outcome ? OUTCOME_REPLIES[outcome] : APPROVER_REPLIES.noAdmin;
  };
}
