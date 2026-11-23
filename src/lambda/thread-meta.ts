import type { StateAdapter } from "chat";
import type { ContextPolicy } from "../config/index.js";

export const THREAD_META_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface ThreadMeta {
  context?: ContextPolicy;
  /** Name of a persistent destination thread; such records never expire. */
  destination?: string;
  setBy: "start-thread";
  at: string;
}

export const threadMetaKey = (threadId: string) => `thread-meta:${threadId}`;

const ttlFor = (meta: ThreadMeta) =>
  meta.destination === undefined ? THREAD_META_TTL_MS : undefined;

export type ThreadMetaStore = ReturnType<typeof createThreadMeta>;

export function createThreadMeta(state: StateAdapter, now: () => Date = () => new Date()) {
  const write = async (
    threadId: string,
    fields: Pick<ThreadMeta, "setBy"> & {
      context?: ContextPolicy | undefined;
      destination?: string | undefined;
    },
  ) => {
    const meta: ThreadMeta = {
      ...(fields.context ? { context: fields.context } : {}),
      ...(fields.destination === undefined ? {} : { destination: fields.destination }),
      setBy: fields.setBy,
      at: now().toISOString(),
    };
    await state.set<ThreadMeta>(threadMetaKey(threadId), meta, ttlFor(meta));
  };

  const read = async (threadId: string): Promise<ThreadMeta | undefined> => {
    const key = threadMetaKey(threadId);
    const meta = await state.get<ThreadMeta>(key);
    if (!meta) return undefined;
    await state.set(key, meta, ttlFor(meta));
    return meta;
  };

  return { write, read };
}
