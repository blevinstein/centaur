import type { Logger } from "chat";
import { z } from "zod";
import type { AccessResolver } from "./access.js";
import { encodeEntry } from "./access-entries.js";
import type { AccessRequestStore } from "./access-request-store.js";
import {
  type ApproverRequester,
  PENDING_TEXT,
  type RaiseOutcome,
  UNREACHABLE_TEXT,
} from "./access-requests.js";
import { lookupAdminId } from "./admin-channel.js";
import { isUserId, loadApproverEntries, MAX_APPROVERS } from "./approvers.js";
import { approverParameter } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const APPROVER_COMMANDS = ["/approver"];

const APPROVER_MESSAGE = /^approver\s+(?:(request|leave|list)|(add|remove)(?:\s+(\S+))?)\s*$/i;
const MENTION = /^<@([^>|]+)(?:\|[^>]*)?>$/;

export type ApproverSubcommand = "request" | "leave" | "list" | "add" | "remove";

const ADMIN_SUBCOMMANDS: readonly ApproverSubcommand[] = ["add", "remove", "list"];

export interface ParsedApproverCommand {
  sub: ApproverSubcommand;
  /** The word after `add` or `remove`: a user ID or a `<@U…>` mention. */
  target?: string | undefined;
}

/** Parses `approver <sub> [target]`; a Telegram `/approver <sub>` passes `approver <sub>`. */
export function readApproverCommand(text: string): ParsedApproverCommand | undefined {
  const match = APPROVER_MESSAGE.exec(text.trim());
  const sub = match?.[1] ?? match?.[2];
  return sub ? { sub: sub.toLowerCase() as ApproverSubcommand, target: match?.[3] } : undefined;
}

export const parseApproverCommand = (text: string) => readApproverCommand(text)?.sub;

const rawTextSchema = z.object({ text: z.string() });

/** The text as the platform sent it: Slack mentions keep their `<@U…>` ID there, not in the normalized text. */
export const commandText = (message: { text: string; raw: unknown }) =>
  rawTextSchema.safeParse(message.raw).data?.text ?? message.text;

/** A person a command points at without naming an ID. */
export interface ApproverPerson {
  userId: string;
  name?: string | undefined;
  isBot: boolean;
}

const telegramReplySchema = z.object({
  reply_to_message: z.object({
    from: z.object({
      id: z.number(),
      is_bot: z.boolean(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      username: z.string().optional(),
    }),
  }),
});

/** The author of the message a Telegram command replies to. */
export function telegramReplyTo(raw: unknown): ApproverPerson | undefined {
  const from = telegramReplySchema.safeParse(raw).data?.reply_to_message.from;
  if (!from) return undefined;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username;
  return { userId: String(from.id), name, isBot: from.is_bot };
}

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
  adminOnly: "Only the admin can do that.",
  noTarget: "Reply to the person's message, or give their user ID.",
  usernameTarget:
    "A username doesn't tell me who that is. Reply to their message, or give their numeric ID.",
  invalidId: "That isn't a valid user ID for this platform.",
  botTarget: "A bot can't be an approver.",
  adminTarget: "That's you, the admin, who is always an approver.",
  added: "Added.",
  removed: "Removed.",
  notListed: "Not an approver.",
  alreadyListed: "Already an approver.",
  noApprovers: "No approvers besides you, the admin, who is always one.",
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
  target?: string | undefined;
  /** The author of the message the command replies to, where the platform has replies. */
  replyTo?: ApproverPerson | undefined;
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

const labelOf = ({ userId, name }: { userId: string; name?: string | undefined }) =>
  name ? `${name} (${userId})` : userId;

export function createApproverCommand({
  bot,
  params,
  store,
  resolveAccess,
  requestApprover,
  logger,
}: ApproverCommandDeps): ApproverCommand {
  const where = { bot: bot.name, platform: bot.platform };

  /** The person a target names: an ID, a mention, or the replied-to author. A string is a refusal. */
  const personOf = (target: string | undefined, replyTo: ApproverPerson | undefined) => {
    if (target === undefined) {
      if (!replyTo) return APPROVER_REPLIES.noTarget;
      if (replyTo.isBot) return APPROVER_REPLIES.botTarget;
      return isUserId(bot.platform, replyTo.userId) ? replyTo : APPROVER_REPLIES.invalidId;
    }
    const userId = MENTION.exec(target)?.[1] ?? target;
    if (userId.startsWith("@")) return APPROVER_REPLIES.usernameTarget;
    return isUserId(bot.platform, userId)
      ? { userId, name: undefined, isBot: false }
      : APPROVER_REPLIES.invalidId;
  };

  const manage = async (
    { sub, isDM, target, replyTo }: ApproverCommandInput,
    admin: string,
  ): Promise<string> => {
    const byReply = target === undefined && replyTo !== undefined;
    if (!isDM && (sub === "list" || !byReply)) return APPROVER_REPLIES.notDirect;
    const entries = await loadApproverEntries(params, bot.name, bot.platform);

    if (sub === "list") {
      if (entries.size === 0) return APPROVER_REPLIES.noApprovers;
      const lines = [...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([userId, { name, at, approver }]) =>
            `${labelOf({ userId, name })}, added ${at}${approver ? ` by ${approver}` : ""}`,
        );
      return ["Approvers (you, the admin, are always one):", ...lines].join("\n");
    }

    const person = personOf(target, replyTo);
    if (typeof person === "string") return person;
    const label = isDM ? labelOf(person) : undefined;
    const parameter = approverParameter(bot.name, bot.platform, person.userId);
    const listed = entries.has(person.userId);

    if (sub === "remove") {
      if (!listed) return APPROVER_REPLIES.notListed;
      await params.delete(parameter);
      logger.info("approver removed", { ...where, userId: person.userId, approver: admin });
      return label ? `Removed ${label} as an approver.` : APPROVER_REPLIES.removed;
    }

    if (person.userId === admin) return APPROVER_REPLIES.adminTarget;
    if (listed) return APPROVER_REPLIES.alreadyListed;
    if (entries.size >= MAX_APPROVERS) return APPROVER_REPLIES.full;
    await params.put(parameter, encodeEntry({ name: person.name, approver: admin }));
    logger.info("approver added", { ...where, userId: person.userId, approver: admin });
    return label ? `Added ${label} as an approver.` : APPROVER_REPLIES.added;
  };

  return async (input) => {
    const { sub, userId, name, isDM, threadId } = input;
    const [access, admin, approvers] = await Promise.all([
      resolveAccess(),
      lookupAdminId(params, bot.platform),
      loadApproverEntries(params, bot.name, bot.platform),
    ]);
    const isApprover = approvers.has(userId);

    if (ADMIN_SUBCOMMANDS.includes(sub)) {
      if (admin && userId === admin) return manage(input, admin);
      return isApprover ? APPROVER_REPLIES.adminOnly : undefined;
    }

    const known = access.userIds.has(userId) || (sub === "leave" && isApprover);
    if (!known) return undefined;
    if (!isDM) return APPROVER_REPLIES.notDirect;

    if (sub === "leave") {
      if (userId === admin) return APPROVER_REPLIES.adminCannotLeave;
      if (!isApprover) return APPROVER_REPLIES.notApprover;
      await params.delete(approverParameter(bot.name, bot.platform, userId));
      logger.info("approver left", { ...where, userId });
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
