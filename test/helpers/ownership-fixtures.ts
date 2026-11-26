import { ADDRESSED_STATE, BOT_CREATED_STATE } from "../../src/lambda/ownership.js";

export const AUTHOR_CASES = [
  ["a human", {}, true],
  ["another bot", { isBot: true }, false],
  ["the bot itself", { isMe: true, isBot: true }, false],
] as const;

export const ADDRESSING_SCENARIOS = {
  DM: { thread: { isDM: true }, mention: false },
  mention: { thread: {}, mention: true },
  "addressed Slack thread": { thread: { state: ADDRESSED_STATE }, mention: false },
  "bot-created thread": { thread: { state: BOT_CREATED_STATE }, mention: false },
} as const;
