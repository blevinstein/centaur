import type { StateAdapter } from "chat";

/**
 * State adapters reject every call except `connect()` and `disconnect()` until `connect()` has
 * completed. `Chat` calls `connect()` on the same adapter again, which is a no-op.
 */
export async function connectState<T extends StateAdapter>(adapter: T): Promise<T> {
  await adapter.connect();
  return adapter;
}
