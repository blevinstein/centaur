import type { ContextPolicy } from "../config/index.js";
import { type Command, parseCommand } from "./commands.js";

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  fromBot: boolean;
  text: string;
  sentAt: string;
}

export type TurnPlan =
  | { kind: "skip" }
  | { kind: "ack"; policy: ContextPolicy }
  | { kind: "new-thread"; seed: ChatMessage[] }
  | { kind: "reply"; policy: ContextPolicy; pending: ChatMessage[] };

const POLICY_COMMANDS: Partial<Record<Command, ContextPolicy>> = {
  resume: "resume",
  transcript: "transcript",
};

/**
 * Human messages after the last-processed marker. Without a marker (or when it has aged out of
 * the stored transcript), everything after the bot's latest message counts as unprocessed.
 */
export function pendingMessages(messages: ChatMessage[], marker: string | undefined) {
  const markerIndex = marker === undefined ? -1 : messages.findIndex((m) => m.id === marker);
  const start = markerIndex >= 0 ? markerIndex + 1 : messages.findLastIndex((m) => m.fromBot) + 1;
  return messages.slice(start).filter((m) => !m.fromBot);
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
    .filter((m) => m.text !== "");
  if (newIndex >= 0) return { kind: "new-thread", seed: relevant };
  return relevant.length === 0
    ? { kind: "ack", policy }
    : { kind: "reply", policy, pending: relevant };
}

export const renderMessages = (messages: ChatMessage[]) =>
  messages
    .map((m) => `[${m.sentAt}] ${m.fromBot ? "assistant" : m.userName}: ${m.text}`)
    .join("\n\n");
