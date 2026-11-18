import { PARAMETER_ROOT, type ParameterStore } from "./parameters.js";

export const PARAMETER_CACHE_TTL_MS = 30_000;

/** Admin claims are single-use and guess-limited, so every check reads the live value. */
const isFresh = (name: string) => name.startsWith(`${PARAMETER_ROOT}/admin-claim/`);

export interface CachedParameterStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Caches present values from `get` for `ttlMs`. Missing parameters are never cached, so a newly
 * created one is visible at once. `getByPath` is not cached (the access resolver caches its own
 * result, and stacking would double the staleness). Writes through this store drop the cached key;
 * writes from elsewhere (the CLI) show up within the TTL.
 */
export function createCachedParameterStore(
  store: ParameterStore,
  { ttlMs = PARAMETER_CACHE_TTL_MS, now = Date.now }: CachedParameterStoreOptions = {},
): ParameterStore {
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const writing =
    <Args extends [string, ...unknown[]], Result>(write: (...args: Args) => Promise<Result>) =>
    async (...args: Args) => {
      try {
        return await write(...args);
      } finally {
        cache.delete(args[0]);
      }
    };
  return {
    ...store,
    get: async (name) => {
      const hit = cache.get(name);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = await store.get(name);
      if (value !== undefined && !isFresh(name)) {
        cache.set(name, { value, expiresAt: now() + ttlMs });
      }
      return value;
    },
    put: writing(store.put),
    putIfAbsent: writing(store.putIfAbsent),
    delete: writing(store.delete),
  };
}
