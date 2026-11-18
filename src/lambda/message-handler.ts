import { emoji, type Logger, type Message, type Thread } from "chat";
import type { RespondTo } from "../config/index.js";
import type { AccessResolver } from "./access.js";
import type { AccessRequester } from "./access-requests.js";
import { type AdminClaimer, CLAIM_MESSAGE } from "./admin-claims.js";
import type { AttachmentStore } from "./attachments.js";
import type { RepositoryDispatcher } from "./github.js";
import { isAddressed, ownsMessage, type ThreadMetadata } from "./ownership.js";
import type { Bot } from "./registry.js";

export const DISPATCH_EVENT_TYPE = "centaur-message";
export const REFUSAL_TEXT = "Sorry, you aren't enrolled to talk to me.";
export const ATTACHMENT_FAILURE_TEXT =
  "Sorry, I couldn't store that attachment, so I haven't processed your message.";

export interface MessageHandlerDeps {
  bot: Bot;
  resolveAccess: AccessResolver;
  requestAccess: AccessRequester;
  attachments: Pick<AttachmentStore, "save">;
  claimAdmin?: AdminClaimer | undefined;
  resolveRespondTo: () => Promise<RespondTo>;
  dispatcher: RepositoryDispatcher;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export function createMessageHandler({
  bot,
  resolveAccess,
  requestAccess,
  attachments,
  claimAdmin,
  resolveRespondTo,
  dispatcher,
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

    const respondTo = await resolveRespondTo();
    if (!(await ownsMessage(thread, message, respondTo))) return;

    const refusable = respondTo === "mention" || isAddressed(thread, message);

    const access = await resolveAccess();
    const chatId = thread.channelId.slice(bot.platform.length + 1);
    const userId = message.author.userId;
    const addressed = isAddressed(thread, message);
    if ((!thread.isDM && access.blockedChatIds.has(chatId)) || access.blockedUserIds.has(userId)) {
      logger.info("ignoring message from blocked subject", { ...where, chatId, userId });
      return;
    }
    if (!thread.isDM && !access.chatIds.has(chatId)) {
      if (addressed && (await requestAccess("chat", thread, message))) return;
      if (refusable) logger.warn("ignoring message from unknown chat", { ...where, chatId });
      return;
    }
    if (!access.userIds.has(userId)) {
      if (addressed && (await requestAccess("user", thread, message))) return;
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
    await dispatcher.dispatch(bot.repo, DISPATCH_EVENT_TYPE, {
      bot: bot.name,
      thread_id: thread.id,
      message_id: message.id,
    });
  };
}
