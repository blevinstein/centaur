import type { ChatMessage } from "../poster-contract.js";
import { splitTextMaxChars } from "./split-text.js";

export interface BoundedTranscript {
  messages: ChatMessage[];
  /** How many of the oldest messages did not fit and are not shown. */
  omitted: number;
}

const shortened = (shown: number, total: number) =>
  `[message shortened: first ${shown} of ${total} characters shown]`;

/**
 * Cuts a message longer than `limit` characters to its first chunk plus a visible marker. `chars`
 * is the message text that counts against the budget; the marker does not.
 */
function cutMessage(message: ChatMessage, limit: number) {
  if (message.text.length <= limit) return { message, chars: message.text.length };
  const [head = ""] = splitTextMaxChars(message.text, limit);
  const text = `${head}\n${shortened(head.length, message.text.length)}`;
  return { message: { ...message, text }, chars: head.length };
}

/**
 * Fits the earlier messages of a thread into `maxChars` characters of message text, newest first,
 * and returns the ones that fit in their original order. A message longer than half the budget is
 * cut first, so one huge message cannot crowd out the rest. The fit stops at the first message that
 * does not fit, so the shown messages are always the newest unbroken run.
 */
export function boundTranscript(earlier: ChatMessage[], maxChars: number): BoundedTranscript {
  const limit = Math.max(1, Math.floor(maxChars / 2));
  const shown: ChatMessage[] = [];
  let used = 0;
  for (const message of earlier.toReversed()) {
    const candidate = cutMessage(message, limit);
    if (used + candidate.chars > maxChars) break;
    used += candidate.chars;
    shown.push(candidate.message);
  }
  return { messages: shown.reverse(), omitted: earlier.length - shown.length };
}
