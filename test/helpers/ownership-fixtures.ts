import type { BotMessages, RespondTo } from "../../src/config/index.js";
import {
  ADDRESSED_STATE,
  BOT_CREATED_STATE,
  type OwnershipSettings,
} from "../../src/lambda/ownership.js";

export const RESPOND_TO_MODES: readonly RespondTo[] = ["mention", "all"];

export const BOT_MESSAGES_MODES: readonly BotMessages[] = ["ignore", "mention"];

export const ownershipSettings = (
  respond_to: RespondTo = "mention",
  bot_messages: BotMessages = "ignore",
): OwnershipSettings => ({ respond_to, bot_messages });

/** Whether a message from each author is owned, given the setting and an explicit mention. */
export const AUTHOR_CASES = [
  ["a human", {}, () => true],
  [
    "another bot",
    { isBot: true },
    (botMessages: BotMessages, mentioned: boolean) => botMessages === "mention" && mentioned,
  ],
  ["the bot itself", { isMe: true, isBot: true }, () => false],
] as const;

export const ADDRESSING_SCENARIOS = {
  DM: { thread: { isDM: true }, mention: false },
  mention: { thread: {}, mention: true },
  "addressed Slack thread": { thread: { state: ADDRESSED_STATE }, mention: false },
  "bot-created thread": { thread: { state: BOT_CREATED_STATE }, mention: false },
} as const;
