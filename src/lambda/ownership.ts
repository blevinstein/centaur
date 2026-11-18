import type { Message, Thread } from "chat";

export interface ThreadMetadata extends Record<string, unknown> {
  createdByBot?: boolean;
}

export async function ownsMessage(
  thread: Thread<ThreadMetadata>,
  message: Message,
): Promise<boolean> {
  if (thread.isDM || message.isMention) return true;
  return (await thread.state)?.createdByBot === true;
}
