import { vi } from "vitest";
import { type RedeliveryDeps, withRedelivery } from "../../src/lambda/redelivery.js";
import { fakeLogger, fakeMessage, fakeThread } from "./receiver-fixtures.js";

export const stateWith = (entries: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(entries));
  const state = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
    delete: vi.fn(async (key: string) => void values.delete(key)),
  } as unknown as RedeliveryDeps["state"];
  return { state, values };
};

export function redeliveryHarness(entries?: Record<string, unknown>) {
  const handler = vi.fn(async () => {});
  const { state, values } = stateWith(entries);
  const logger = fakeLogger();
  const { thread, post } = fakeThread();
  const removeReaction = vi.fn(async () => {});
  Object.assign(thread.adapter, { name: "telegram", removeReaction });
  const handle = withRedelivery(handler, { state, logger });
  return {
    handler,
    handle: () => handle(thread, fakeMessage()),
    values,
    logger,
    post,
    removeReaction,
  };
}
