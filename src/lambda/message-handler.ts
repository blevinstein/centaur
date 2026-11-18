import { emoji, type Logger, type Message, type Thread } from "chat";
import type { AccessResolver } from "./access.js";
import type { RepositoryDispatcher } from "./github.js";
import { ownsMessage, type ThreadMetadata } from "./ownership.js";
import type { Bot } from "./registry.js";

export const DISPATCH_EVENT_TYPE = "centaur-message";
export const REFUSAL_TEXT = "Sorry, you aren't enrolled to talk to me.";

export interface MessageHandlerDeps {
  bot: Bot;
  resolveAccess: AccessResolver;
  dispatcher: RepositoryDispatcher;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export function createMessageHandler({
  bot,
  resolveAccess,
  dispatcher,
  logger,
}: MessageHandlerDeps) {
  const where = { bot: bot.name, platform: bot.platform };
  return async (thread: Thread<ThreadMetadata>, message: Message): Promise<void> => {
    if (!(await ownsMessage(thread, message))) return;

    const access = await resolveAccess();
    const chatId = thread.channelId.slice(bot.platform.length + 1);
    if (!thread.isDM && !access.chatIds.has(chatId)) {
      logger.warn("ignoring message from unknown chat", { ...where, chatId });
      return;
    }
    const userId = message.author.userId;
    if (!access.userIds.has(userId)) {
      logger.warn("refusing unknown sender", { ...where, chatId, userId });
      await thread.post(REFUSAL_TEXT);
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
