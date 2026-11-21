import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";

export const NOT_CONNECTED = "adapter is not connected. Call connect() first.";
export const CONNECT_FAILURE = "table is missing";

/** Wraps a memory adapter with the Chat SDK contract: every method but connect and disconnect rejects until connect() completes. */
function strictAdapter(inner: StateAdapter, counters: { connects: number; failures: number }) {
  let connected = false;
  return new Proxy(inner, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          if (connected) return;
          counters.connects += 1;
          if (counters.failures > 0) {
            counters.failures -= 1;
            throw new Error(CONNECT_FAILURE);
          }
          await target.connect();
          connected = true;
        };
      }
      if (property === "disconnect") {
        return async () => {
          connected = false;
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (!connected) throw new Error(NOT_CONNECTED);
        return value.apply(target, args);
      };
    },
  });
}

/** A strict adapter per `createState(prefix)` call, sharing one memory store and counters per prefix. `inner(prefix)` is the unguarded memory adapter, for seeding. */
export function strictStates({
  failConnects = {},
}: {
  failConnects?: Record<string, number>;
} = {}) {
  const entries = new Map<
    string,
    { inner: StateAdapter; counters: { connects: number; failures: number } }
  >();
  const entry = (prefix: string) => {
    let found = entries.get(prefix);
    if (!found) {
      found = {
        inner: createMemoryState(),
        counters: { connects: 0, failures: failConnects[prefix] ?? 0 },
      };
      entries.set(prefix, found);
    }
    return found;
  };
  return {
    createState: (prefix: string) => strictAdapter(entry(prefix).inner, entry(prefix).counters),
    inner: (prefix: string) => entry(prefix).inner,
    connects: (prefix: string) => entry(prefix).counters.connects,
    prefixes: () => [...entries.keys()],
  };
}
