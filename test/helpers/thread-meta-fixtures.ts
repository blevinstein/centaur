import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import {
  createThreadMeta,
  type ThreadMetaStore,
  threadMetaKey,
} from "../../src/lambda/thread-meta.js";
import { destinationPoster, GARDEN_SLACK_CHANNEL_PARAMETERS } from "./destination-fixtures.js";
import { createFreshTable, scanItems } from "./dynamodb-local.js";
import { HOUSEHOLD_CHAT_ID, TOPIC_ID } from "./poster-fixtures.js";

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
  const setup = await destinationPoster({
    ...(options.twoConnections ? { parameters: GARDEN_SLACK_CHANNEL_PARAMETERS } : {}),
  });
  return { ...setup, gardenThreadMeta: () => setup.threadMetaOf("garden") };
}
