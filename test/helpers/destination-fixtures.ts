import type { Mock } from "vitest";
import type { Platform } from "../../src/config/index.js";
import { approvedParameter, scopedChatParameter } from "../../src/lambda/connection-paths.js";
import {
  type Destination,
  type DestinationFields,
  encodeDestination,
  parseDestination,
} from "../../src/lambda/destinations.js";
import type { ParameterStore } from "../../src/lambda/parameters.js";
import { botStatePrefix } from "../../src/lambda/registry.js";
import { createThreadMeta } from "../../src/lambda/thread-meta.js";
import {
  GARDEN_REPOSITORY,
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_CHANNEL_ID,
  SLACK_POST_THREAD_ID,
  TOPIC_ID,
} from "./poster-fixtures.js";
import { connectionParameters, GARDEN_SLACK_PARAMETERS } from "./receiver-fixtures.js";

export const GARDEN_CONNECTION = { name: "garden", platform: "telegram" } as const;
export const TELEGRAM_TOPIC = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;
export const RECREATED_TOPIC_ID = 88;
export const RECREATED_TOPIC = `telegram:${HOUSEHOLD_CHAT_ID}:${RECREATED_TOPIC_ID}`;
export const WEEKLY_PARAMETER = scopedChatParameter("telegram", "weekly");
export const TOPIC_GONE_ERROR = "Bad Request: message thread not found (status 400, error 400)";
export const TOPIC_CLOSED_ERROR = "Bad Request: TOPIC_CLOSED (status 400, error 400)";
export const NOT_A_FORUM_ERROR = "Bad Request: the chat is not a forum (status 400, error 400)";

export const START_WEEKLY = {
  operation: "start-thread",
  bot: "garden",
  destination: "weekly",
  text: "x",
} as const;
export const START_WEEKLY_PERSISTENT = { ...START_WEEKLY, thread: "persistent" } as const;

export const destinationAt = (
  params: ParameterStore & { values: Record<string, string> },
  platform: Platform,
  name: string,
): Destination => parseDestination(params.values[scopedChatParameter(platform, name)] as string);

export const chatIdAt = async (
  store: { get(name: string): Promise<string | undefined> },
  parameter: string,
) => {
  const value = await store.get(parameter);
  return value === undefined ? undefined : parseDestination(value).chatId;
};

export const boundWeekly = (overrides: Partial<DestinationFields> = {}) =>
  encodeDestination({
    chatId: HOUSEHOLD_CHAT_ID,
    threadId: TELEGRAM_TOPIC,
    bot: "garden",
    ...overrides,
  });

/** A Telegram bot with one approved group chat, or with the given ones. */
export const soloBotParameters = (approvedChatIds: string[] = [HOUSEHOLD_CHAT_ID]) => ({
  ...connectionParameters(
    { name: "solo", platform: "telegram", token: "solo-token", webhookSecret: "solo-secret" },
    GARDEN_REPOSITORY,
  ),
  ...Object.fromEntries(
    approvedChatIds.map((chatId) => [approvedParameter("solo", "telegram", "chat", chatId), "{}"]),
  ),
});

/** A poster whose `weekly` destination holds `weekly` (a bare chat ID or a record), if given. */
export async function destinationPoster(
  options: { weekly?: string; parameters?: Record<string, string> } = {},
) {
  const setup = await posterSetup({
    repository: GARDEN_REPOSITORY,
    parameters: {
      ...(options.weekly === undefined ? {} : { [WEEKLY_PARAMETER]: options.weekly }),
      ...options.parameters,
    },
  });
  const threadMetaOf = (bot: string) => {
    const index = setup.createState.mock.calls.findIndex(
      ([prefix]) => prefix === botStatePrefix(bot),
    );
    return createThreadMeta(setup.createState.mock.results[index]?.value);
  };
  return {
    ...setup,
    threadMetaOf,
    weekly: () => destinationAt(setup.params, "telegram", "weekly"),
  };
}

/** The garden bot's Slack connection with an approved channel named `garden-channel`. */
export const GARDEN_SLACK_CHANNEL_PARAMETERS = {
  ...GARDEN_SLACK_PARAMETERS,
  [scopedChatParameter("slack", "garden-channel")]: SLACK_CHANNEL_ID,
  [approvedParameter("garden", "slack", "chat", SLACK_CHANNEL_ID)]: "{}",
};

export const NOTES_PARAMETER = scopedChatParameter("slack", "notes-channel");
export const SLACK_ARCHIVED_ERROR = "An API error occurred: is_archived";
export const SLACK_PARENT_GONE_ERROR = "An API error occurred: message_not_found";
export const RECREATED_SLACK_THREAD = `slack:${SLACK_CHANNEL_ID}:1700000001.000200`;

export const START_NOTES = {
  operation: "start-thread",
  bot: "notes",
  destination: "notes-channel",
  text: "x",
} as const;
export const START_NOTES_PERSISTENT = { ...START_NOTES, thread: "persistent" } as const;

export const boundNotes = (overrides: Partial<DestinationFields> = {}) =>
  encodeDestination({
    chatId: SLACK_CHANNEL_ID,
    threadId: SLACK_POST_THREAD_ID,
    bot: "notes",
    ...overrides,
  });

/** A poster whose Slack `notes-channel` destination holds `notes`, with accessors for its record. */
export async function slackDestinationPoster(notes: string = SLACK_CHANNEL_ID) {
  const setup = await destinationPoster({ parameters: { [NOTES_PARAMETER]: notes } });
  return { ...setup, notes: () => destinationAt(setup.params, "slack", "notes-channel") };
}

/** Holds the next Slack channel post until `release` is called, once it has started. */
export function holdNextChannelPost(
  channelPost: Mock<() => Promise<{ id: string; threadId: string }>>,
) {
  let release = () => {};
  channelPost.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ id: "sent-2", threadId: SLACK_POST_THREAD_ID });
      }),
  );
  return () => release();
}
