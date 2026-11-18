import { emoji, type Logger, type Message, type Thread } from "chat";
import type { RespondTo } from "../config/index.js";
import type { AccessResolver } from "./access.js";
import type { RepositoryDispatcher } from "./github.js";
import { isAddressed, ownsMessage, type ThreadMetadata } from "./ownership.js";
import type { Bot } from "./registry.js";

export const DISPATCH_EVENT_TYPE = "centaur-message";
export const REFUSAL_TEXT = "Sorry, you aren't enrolled to talk to me.";

export interface MessageHandlerDeps {
  bot: Bot;
  resolveAccess: AccessResolver;
  resolveRespondTo: () => Promise<RespondTo>;
  dispatcher: RepositoryDispatcher;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export function createMessageHandler({
  bot,
  resolveAccess,
  resolveRespondTo,
  dispatcher,
  logger,
}: MessageHandlerDeps) {
  const where = { bot: bot.name, platform: bot.platform };
  return async (thread: Thread<ThreadMetadata>, message: Message): Promise<void> => {
    const respondTo = await resolveRespondTo();
    if (!(await ownsMessage(thread, message, respondTo))) return;

    const refusable = respondTo === "mention" || isAddressed(thread, message);

    const access = await resolveAccess();
    const chatId = thread.channelId.slice(bot.platform.length + 1);
    if (!thread.isDM && !access.chatIds.has(chatId)) {
      if (refusable) logger.warn("ignoring message from unknown chat", { ...where, chatId });
      return;
    }
    const userId = message.author.userId;
    if (!access.userIds.has(userId)) {
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
