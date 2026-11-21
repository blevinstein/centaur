import { createHash } from "node:crypto";

export const THREAD_KEY_LENGTH = 12;

/** Opaque per-(bot, thread) identifier that stands in for the thread ID in public GitHub names. */
export const threadKey = (bot: string, threadId: string) =>
  createHash("sha256").update(`${bot}\0${threadId}`).digest("hex").slice(0, THREAD_KEY_LENGTH);
