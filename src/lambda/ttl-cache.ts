export function cachedFor<T>(ttlMs: number, load: () => Promise<T>) {
  let cached: { value: Promise<T>; expiresAt: number } | undefined;
  const get = () => {
    if (!cached || cached.expiresAt <= Date.now()) {
      const value = load();
      const entry = { value, expiresAt: Date.now() + ttlMs };
      cached = entry;
      value.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.value;
  };
  return Object.assign(get, {
    invalidate: () => {
      cached = undefined;
    },
  });
}
