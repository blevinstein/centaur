import type { Message, Thread } from "chat";
import type { RespondTo } from "../config/index.js";

export interface ThreadMetadata extends Record<string, unknown> {
  createdByBot?: boolean;
}

export const BOT_CREATED_STATE: ThreadMetadata = { createdByBot: true };

export const isAddressed = (thread: Thread<ThreadMetadata>, message: Message) =>
  thread.isDM || message.isMention;

export async function ownsMessage(
  thread: Thread<ThreadMetadata>,
  message: Message,
  respondTo: RespondTo,
): Promise<boolean> {
  if (respondTo === "all") return !message.author.isMe && message.author.isBot !== true;
  if (isAddressed(thread, message)) return true;
  return (await thread.state)?.createdByBot === true;
}
