import { emoji, type Logger, type Message, type Thread } from "chat";
import { threadKey } from "../thread-key.js";
import type { AccessResolver } from "./access.js";
import type { AccessKind } from "./access-entries.js";
import type { AccessRequester } from "./access-requests.js";
import { type AdminClaimer, CLAIM_MESSAGE } from "./admin-claims.js";
import { type ApproverCommand, commandText, readApproverCommand } from "./approver-commands.js";
import type { AttachmentStore } from "./attachments.js";
import type { RepositoryDispatcher } from "./github.js";
import {
  isAddressed,
  type OwnershipSettings,
  ownsMessage,
  rememberAddressed,
  type ThreadMetadata,
} from "./ownership.js";
import type { Bot } from "./registry.js";
import type { SearchTokenStore } from "./search-token.js";
import type { ThreadMetaStore } from "./thread-meta.js";

export const DISPATCH_EVENT_TYPE = "centaur-message";
export const dispatchMessage = (
  dispatcher: RepositoryDispatcher,
  bot: Pick<Bot, "name" | "repo">,
  threadId: string,
  messageId: string,
) =>
  dispatcher.dispatch(bot.repo, DISPATCH_EVENT_TYPE, {
    bot: bot.name,
    thread_id: threadId,
    thread_key: threadKey(bot.name, threadId),
    message_id: messageId,
  });

export const REFUSAL_TEXT = "Sorry, you aren't enrolled to talk to me.";
export const ATTACHMENT_FAILURE_TEXT =
  "Sorry, I couldn't store that attachment, so I haven't processed your message.";

export interface MessageHandlerDeps {
  bot: Bot;
  resolveAccess: AccessResolver;
  requestAccess: AccessRequester;
  attachments: Pick<AttachmentStore, "save">;
  claimAdmin?: AdminClaimer | undefined;
  /** Slack has no slash commands, so it answers the `approver` words here. */
  approverCommand?: ApproverCommand | undefined;
  /** Undefined when the connection is not registered; the message is then ignored. */
  resolveSettings: () => Promise<OwnershipSettings | undefined>;
  dispatcher: RepositoryDispatcher;
  /** Threads the bot started keep their record beyond the Chat SDK thread-state expiry. */
  threadMeta: Pick<ThreadMetaStore, "read">;
  /** Keeps the Slack `action_token` a later `search-chat` call needs. */
  searchTokens: Pick<SearchTokenStore, "capture">;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export function createMessageHandler({
  bot,
  resolveAccess,
  requestAccess,
  attachments,
  claimAdmin,
  approverCommand,
  resolveSettings,
  dispatcher,
  threadMeta,
  searchTokens,
  logger,
}: MessageHandlerDeps) {
  const where = { bot: bot.name, platform: bot.platform };
  return async (thread: Thread<ThreadMetadata>, message: Message): Promise<void> => {
    const code = claimAdmin && thread.isDM ? CLAIM_MESSAGE.exec(message.text)?.[1] : undefined;
    if (claimAdmin && code) {
      const reply = await claimAdmin({ userId: message.author.userId, isDM: true, code });
      if (reply) {
        await thread.post(reply);
        return;
      }
    }

    const settings = await resolveSettings();
    if (!settings || !(await ownsMessage(thread, message, settings, threadMeta))) return;

    const refusable = settings.respond_to === "mention" || isAddressed(thread, message);

    const command = approverCommand ? readApproverCommand(commandText(message)) : undefined;
    if (approverCommand && command) {
      const reply = await approverCommand({
        ...command,
        userId: message.author.userId,
        name: message.author.fullName || message.author.userName,
        isDM: thread.isDM,
        threadId: thread.id,
      });
      if (reply) {
        await thread.post(reply);
        return;
      }
    }

    const access = await resolveAccess();
    const chatId = thread.channelId.slice(bot.platform.length + 1);
    const userId = message.author.userId;
    const addressed = isAddressed(thread, message);
    if ((!thread.isDM && access.blockedChatIds.has(chatId)) || access.blockedUserIds.has(userId)) {
      logger.info("ignoring message from blocked subject", { ...where, chatId, userId });
      return;
    }
    const unknownChat = !thread.isDM && !access.chatIds.has(chatId);
    const unknownUser = !access.userIds.has(userId);
    if (addressed && (unknownChat || unknownUser)) {
      const kinds: AccessKind[] = [
        ...(unknownChat ? ["chat" as const] : []),
        ...(unknownUser ? ["user" as const] : []),
      ];
      if (await requestAccess(kinds, thread, message)) return;
    }
    if (unknownChat) {
      if (refusable) logger.warn("ignoring message from unknown chat", { ...where, chatId });
      return;
    }
    if (unknownUser) {
      if (refusable) {
        logger.warn("refusing unknown sender", { ...where, chatId, userId });
        await thread.post(REFUSAL_TEXT);
      } else {
        logger.info("ignoring unaddressed message from unknown sender", {
          ...where,
          chatId,
          userId,
        });
      }
      return;
    }

    await rememberAddressed(thread, message, bot.platform);

    try {
      await attachments.save(bot.name, message);
    } catch (error) {
      logger.error("failed to store attachments", { ...where, threadId: thread.id, error });
      await thread.post(ATTACHMENT_FAILURE_TEXT);
      return;
    }

    try {
      await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
    } catch (error) {
      logger.error("failed to add reaction", { ...where, threadId: thread.id, error });
    }
    try {
      if (await searchTokens.capture(thread.id, message)) {
        logger.info("captured search token", { ...where, threadId: thread.id });
      }
    } catch (error) {
      logger.error("failed to store search token", { ...where, threadId: thread.id, error });
    }
    await dispatchMessage(dispatcher, bot, thread.id, message.id);
  };
}
