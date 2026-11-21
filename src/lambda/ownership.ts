import type { Message, Thread } from "chat";
import type { Platform, RespondTo } from "../config/index.js";

export interface ThreadMetadata extends Record<string, unknown> {
  createdByBot?: boolean;
  addressedByUser?: boolean;
}

export const BOT_CREATED_STATE: ThreadMetadata = { createdByBot: true };

export const ADDRESSED_STATE: ThreadMetadata = { addressedByUser: true };

const THREAD_SCOPED_PLATFORMS: ReadonlySet<Platform> = new Set(["slack"]);

export const isAddressed = (thread: Thread<ThreadMetadata>, message: Message) =>
  thread.isDM || message.isMention;

export async function ownsMessage(
  thread: Thread<ThreadMetadata>,
  message: Message,
  respondTo: RespondTo,
): Promise<boolean> {
  if (respondTo === "all") return !message.author.isMe && message.author.isBot !== true;
  if (isAddressed(thread, message)) return true;
  const state = await thread.state;
  return state?.createdByBot === true || state?.addressedByUser === true;
}

export async function rememberAddressed(
  thread: Thread<ThreadMetadata>,
  message: Message,
  platform: Platform,
): Promise<void> {
  if (THREAD_SCOPED_PLATFORMS.has(platform) && isAddressed(thread, message) && !thread.isDM) {
    await thread.setState(ADDRESSED_STATE);
  }
}
