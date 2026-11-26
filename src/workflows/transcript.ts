import type { ContextPolicy } from "../config/index.js";
import type { ChatMessage } from "../poster-contract.js";
import { type Command, parseCommand } from "./commands.js";

export type TurnPlan =
  | { kind: "skip" }
  | { kind: "ack"; policy: ContextPolicy }
  | { kind: "new-thread"; seed: ChatMessage[] }
  | { kind: "reply"; policy: ContextPolicy; pending: ChatMessage[] };

const POLICY_COMMANDS: Partial<Record<Command, ContextPolicy>> = {
  resume: "resume",
  transcript: "transcript",
};

/** A marker meaning that no message of the thread has been processed. */
export const NOTHING_PROCESSED = "centaur:nothing-processed";

/**
 * Human messages after the last-processed marker. Without a marker (or when it has aged out of
 * the stored transcript), everything after the bot's latest message counts as unprocessed.
 */
export function pendingMessages(messages: ChatMessage[], marker: string | undefined) {
  const markerIndex = marker === undefined ? -1 : messages.findIndex((m) => m.id === marker);
  const start =
    marker === NOTHING_PROCESSED
      ? 0
      : markerIndex >= 0
        ? markerIndex + 1
        : messages.findLastIndex((m) => m.fromBot) + 1;
  return messages.slice(start).filter((m) => !m.fromBot);
}

/**
 * The marker that leaves `pending` unprocessed regardless of the bot messages posted after it: the
 * message before the first pending one, or `NOTHING_PROCESSED` when it opens the thread.
 */
export function markerBefore(messages: ChatMessage[], marker: string | undefined) {
  const first = messages.findIndex((m) => m.id === pendingMessages(messages, marker)[0]?.id);
  return (first > 0 ? messages[first - 1]?.id : undefined) ?? NOTHING_PROCESSED;
}

export function threadPolicy(messages: ChatMessage[], fallback: ContextPolicy): ContextPolicy {
  return messages.reduce<ContextPolicy>((policy, message) => {
    const command = message.fromBot ? undefined : parseCommand(message.text).command;
    return (command && POLICY_COMMANDS[command]) || policy;
  }, fallback);
}

const withoutCommand = (message: ChatMessage): ChatMessage => ({
  ...message,
  text: parseCommand(message.text).text,
});

export function planTurn(input: {
  messages: ChatMessage[];
  marker: string | undefined;
  defaultPolicy: ContextPolicy;
}): TurnPlan {
  const pending = pendingMessages(input.messages, input.marker);
  if (pending.length === 0) return { kind: "skip" };
  const policy = threadPolicy(input.messages, input.defaultPolicy);
  const newIndex = pending.findLastIndex((m) => parseCommand(m.text).command === "new");
  const relevant = (newIndex >= 0 ? pending.slice(newIndex) : pending)
    .map(withoutCommand)
    .filter((m) => m.text !== "" || m.attachments.length > 0);
  if (newIndex >= 0) return { kind: "new-thread", seed: relevant };
  if (relevant.length > 0) return { kind: "reply", policy, pending: relevant };
  return pending.some((m) => parseCommand(m.text).command)
    ? { kind: "ack", policy }
    : { kind: "skip" };
}

/** Maps an attachment key to the file the agent can open, or undefined when it was not loaded. */
export type AttachmentPath = (key: string) => string | undefined;

const renderAttachment = (key: string, localPath: AttachmentPath) => {
  const path = localPath(key);
  return path ? `[attached image: ${path}]` : "[attached image, not loaded]";
};

export const renderMessages = (messages: ChatMessage[], localPath: AttachmentPath) =>
  messages
    .map((m) => {
      const body = [m.text, ...m.attachments.map((key) => renderAttachment(key, localPath))]
        .filter((part) => part !== "")
        .join("\n");
      return `[${m.sentAt}] ${m.fromBot ? "assistant" : m.userName}: ${body}`;
    })
    .join("\n\n");
