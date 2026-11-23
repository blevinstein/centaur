import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { botStatePrefix } from "../../src/lambda/registry.js";
import {
  createThreadMeta,
  type ThreadMetaStore,
  threadMetaKey,
} from "../../src/lambda/thread-meta.js";
import { createFreshTable, scanItems } from "./dynamodb-local.js";
import {
  approvedChat,
  GARDEN_REPOSITORY,
  HOUSEHOLD_CHAT_ID,
  posterSetup,
  SLACK_CHANNEL_ID,
  TOPIC_ID,
} from "./poster-fixtures.js";
import { GARDEN_SLACK_PARAMETERS } from "./receiver-fixtures.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_THREAD = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;
export const START_HOUSEHOLD = {
  operation: "start-thread",
  bot: "garden",
  destination: "household",
  text: "x",
} as const;
export const START_GARDEN_CHANNEL = {
  operation: "start-thread",
  bot: "garden",
  destination: "garden-channel",
  text: "x",
} as const;
export const readThread = (threadId: string) =>
  ({ operation: "read", token: "jwt", bot: "garden", threadId }) as const;

export const noThreadMeta = () => ({ read: vi.fn<ThreadMetaStore["read"]>(async () => undefined) });

export async function memoryThreadMeta() {
  const state = createMemoryState();
  await state.connect();
  return createThreadMeta(state);
}

export async function dynamoThreadMeta() {
  const table = await createFreshTable();
  const state = createDynamoDBState(table);
  await state.connect();
  return {
    threadMeta: createThreadMeta(state),
    expiryOf: async (threadId: string) =>
      (await scanItems(table)).find((item) => String(item.pk).includes(threadMetaKey(threadId)))
        ?.expiresAt,
  };
}

export async function gardenPoster(options: { twoConnections?: boolean } = {}) {
  const setup = await posterSetup({
    repository: GARDEN_REPOSITORY,
    ...(options.twoConnections
      ? {
          parameters: {
            ...GARDEN_SLACK_PARAMETERS,
            "/centaur/chats/slack/garden-channel": SLACK_CHANNEL_ID,
            [approvedChat("garden", SLACK_CHANNEL_ID, "slack")]: "{}",
          },
        }
      : {}),
  });
  const gardenThreadMeta = () => {
    const index = setup.createState.mock.calls.findIndex(
      ([prefix]) => prefix === botStatePrefix("garden"),
    );
    return createThreadMeta(setup.createState.mock.results[index]?.value);
  };
  return { ...setup, gardenThreadMeta };
}
