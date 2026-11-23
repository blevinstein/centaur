import type { Logger, Message, Thread } from "chat";
import type { AccessKind } from "./access-entries.js";
import type { AccessRequestStore } from "./access-request-store.js";
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
const DAY_MS = 24 * 60 * 60 * 1000;

const oneLine = (value: string | undefined) =>
  value?.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || UNKNOWN_NAME;

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

export function createAccessRequester({
  bot,
  params,
  store,
  channel,
  messenger,
  logger,
}: AccessRequesterDeps): AccessRequester {
  const where = { bot: bot.name, platform: bot.platform };
  return async (kind, thread, message) => {
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return false;

    const chatId = thread.channelId.slice(bot.platform.length + 1);
    const requesterId = message.author.userId;
    const requesterName = oneLine(message.author.fullName || message.author.userName);
    const subjectId = kind === "chat" ? chatId : requesterId;

    if (!(await store.claimSubject(kind, subjectId))) {
      if (await store.claimPendingNotice(kind, subjectId)) await thread.post(PENDING_TEXT);
      return true;
    }
    if (await store.overLimit()) {
      await store.releaseSubject(kind, subjectId);
      logger.info("access request limit reached; dropping request", { ...where, kind, subjectId });
      return true;
    }
    const title = thread.isDM ? DM_TITLE : await chatTitle(thread);
    const destinationName =
      kind === "chat"
        ? proposeDestinationName(
            parseDestinations(await params.getByPath(scopedChatPrefix(bot.platform))),
            chatId,
            title,
          )
        : undefined;
    const request = await store.create({
      kind,
      subjectId,
      subjectName: kind === "chat" ? (title ?? UNKNOWN_NAME) : requesterName,
      ...(destinationName ? { alias: destinationName } : {}),
      threadId: thread.id,
    });
    await store.recordRequest();

    const lines = [
      `Access request ${request.id}`,
      `Bot: ${bot.name}`,
      `Kind: ${kind}`,
      `Requester: ${requesterName} (${requesterId})`,
      `Chat: ${title ?? UNKNOWN_NAME} (${chatId})`,
      ...(destinationName ? [`Destination: ${destinationName}`] : []),
      `React ${APPROVE_EMOJI} to approve, or ${DENY_EMOJI} to deny and block.`,
      ...(channel.commands ? [`Or reply /approve ${request.id} or /deny ${request.id}.`] : []),
      `Expires in ${store.ttlMs / DAY_MS} days.`,
    ];
    try {
      await store.linkMessage(await channel.notify(messenger, adminId, lines.join("\n")), request);
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
      await thread.post(UNREACHABLE_TEXT);
      return true;
    }
    await thread.post(REQUESTED_TEXT);
    return true;
  };
}
