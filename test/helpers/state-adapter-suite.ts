import type { Lock, QueueEntry, StateAdapter } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const entry = (id: string, enqueuedAt = 1000): QueueEntry =>
  ({ message: { id }, enqueuedAt, expiresAt: Date.now() + 90_000 }) as unknown as QueueEntry;

const ids = (entries: (QueueEntry | null)[]) =>
  entries.map((queued) => (queued?.message as unknown as { id: string } | undefined)?.id);

const drain = async (adapter: StateAdapter, threadId: string) => {
  const drained: (QueueEntry | null)[] = [];
  for (let next = await adapter.dequeue(threadId); next; next = await adapter.dequeue(threadId)) {
    drained.push(next);
  }
  return drained;
};

const acquired = async (adapter: StateAdapter, threadId: string, ttlMs = 5000): Promise<Lock> => {
  const lock = await adapter.acquireLock(threadId, ttlMs);
  expect(lock).not.toBeNull();
  return lock as Lock;
};

export function defineStateAdapterSuite(
  name: string,
  create: () => Promise<StateAdapter> | StateAdapter,
): void {
  describe(name, () => {
    let adapter: StateAdapter;

    beforeEach(async () => {
      adapter = await create();
      await adapter.connect();
    });

    describe("subscriptions", () => {
      it("subscribes to a thread", async () => {
        await adapter.subscribe("slack:C123:1234.5678");
        expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(true);
      });

      it("unsubscribes from a thread", async () => {
        await adapter.subscribe("slack:C123:1234.5678");
        await adapter.unsubscribe("slack:C123:1234.5678");
        expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(false);
      });

      it("reports unknown threads as unsubscribed", async () => {
        expect(await adapter.isSubscribed("unknown")).toBe(false);
      });
    });

    describe("locking", () => {
      it("acquires a lock", async () => {
        const lock = await acquired(adapter, "thread1");
        expect(lock.threadId).toBe("thread1");
        expect(lock.token).toBeTruthy();
      });

      it("prevents double-locking", async () => {
        await acquired(adapter, "thread1");
        expect(await adapter.acquireLock("thread1", 5000)).toBeNull();
      });

      it("grants exactly one of many concurrent acquisitions", async () => {
        const locks = await Promise.all(
          Array.from({ length: 10 }, () => adapter.acquireLock("thread1", 5000)),
        );
        expect(locks.filter(Boolean)).toHaveLength(1);
      });

      it("releases a lock", async () => {
        await adapter.releaseLock(await acquired(adapter, "thread1"));
        expect(await adapter.acquireLock("thread1", 5000)).not.toBeNull();
      });

      it("does not release a lock with the wrong token", async () => {
        await acquired(adapter, "thread1");
        await adapter.releaseLock({
          threadId: "thread1",
          token: "fake",
          expiresAt: Date.now() + 5000,
        });
        expect(await adapter.acquireLock("thread1", 5000)).toBeNull();
      });

      it("allows re-locking after expiry", async () => {
        const first = await acquired(adapter, "thread1", 10);
        await sleep(20);
        const second = await acquired(adapter, "thread1");
        expect(second.token).not.toBe(first.token);
      });

      it("ignores the previous holder's release after takeover", async () => {
        const first = await acquired(adapter, "thread1", 10);
        await sleep(20);
        await acquired(adapter, "thread1");
        await adapter.releaseLock(first);
        expect(await adapter.acquireLock("thread1", 5000)).toBeNull();
      });

      it("extends a lock", async () => {
        const lock = await acquired(adapter, "thread1", 100);
        expect(await adapter.extendLock(lock, 5000)).toBe(true);
        await sleep(150);
        expect(await adapter.acquireLock("thread1", 5000)).toBeNull();
      });

      it("does not extend a lock with the wrong token", async () => {
        const lock = await acquired(adapter, "thread1");
        expect(await adapter.extendLock({ ...lock, token: "fake" }, 5000)).toBe(false);
      });

      it("does not extend an expired lock", async () => {
        const lock = await acquired(adapter, "thread1", 10);
        await sleep(20);
        expect(await adapter.extendLock(lock, 5000)).toBe(false);
        expect(await adapter.acquireLock("thread1", 5000)).not.toBeNull();
      });

      it("does not resurrect a released lock on extend", async () => {
        const lock = await acquired(adapter, "thread1");
        await adapter.releaseLock(lock);
        expect(await adapter.extendLock(lock, 5000)).toBe(false);
        expect(await adapter.acquireLock("thread1", 5000)).not.toBeNull();
      });

      it("force-releases a lock regardless of token", async () => {
        const lock = await acquired(adapter, "thread1");
        await adapter.forceReleaseLock("thread1");
        const next = await acquired(adapter, "thread1");
        expect(next.token).not.toBe(lock.token);
      });

      it("no-ops when force-releasing a non-existent lock", async () => {
        await expect(adapter.forceReleaseLock("nonexistent")).resolves.toBeUndefined();
      });
    });

    describe("get / set / delete", () => {
      it("round-trips JSON values", async () => {
        const value = { a: [1, "two", null], b: { c: true } };
        await adapter.set("key1", value);
        expect(await adapter.get("key1")).toEqual(value);
      });

      it("returns null for missing keys", async () => {
        expect(await adapter.get("missing")).toBeNull();
      });

      it("overwrites existing values", async () => {
        await adapter.set("key1", "first");
        await adapter.set("key1", "second");
        expect(await adapter.get("key1")).toBe("second");
      });

      it("deletes values", async () => {
        await adapter.set("key1", "value");
        await adapter.delete("key1");
        expect(await adapter.get("key1")).toBeNull();
      });

      it("expires values after their TTL", async () => {
        await adapter.set("key1", "value", 10);
        await sleep(20);
        expect(await adapter.get("key1")).toBeNull();
      });
    });

    describe("setIfNotExists", () => {
      it("sets a value when the key does not exist", async () => {
        expect(await adapter.setIfNotExists("key1", "value1")).toBe(true);
        expect(await adapter.get("key1")).toBe("value1");
      });

      it("does not overwrite an existing key", async () => {
        await adapter.setIfNotExists("key1", "first");
        expect(await adapter.setIfNotExists("key1", "second")).toBe(false);
        expect(await adapter.get("key1")).toBe("first");
      });

      it("lets exactly one of many concurrent calls win", async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => adapter.setIfNotExists("key1", i)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it("allows setting after TTL expiry", async () => {
        await adapter.setIfNotExists("key1", "first", 10);
        await sleep(20);
        expect(await adapter.setIfNotExists("key1", "second")).toBe(true);
        expect(await adapter.get("key1")).toBe("second");
      });

      it("respects TTL on the new value", async () => {
        await adapter.setIfNotExists("key1", "value", 10);
        await sleep(20);
        expect(await adapter.get("key1")).toBeNull();
      });
    });

    describe("appendToList / getList", () => {
      it("appends and retrieves list items in order", async () => {
        await adapter.appendToList("list1", { id: 1 });
        await adapter.appendToList("list1", { id: 2 });
        expect(await adapter.getList("list1")).toEqual([{ id: 1 }, { id: 2 }]);
      });

      it("returns an empty array for a non-existent list", async () => {
        expect(await adapter.getList("nonexistent")).toEqual([]);
      });

      it("trims to maxLength, keeping newest", async () => {
        for (let i = 1; i <= 5; i++) {
          await adapter.appendToList("list1", { id: i }, { maxLength: 3 });
        }
        expect(await adapter.getList("list1")).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }]);
      });

      it("keeps the newest entries under concurrent appends", async () => {
        await Promise.all(
          Array.from({ length: 12 }, (_, i) => adapter.appendToList("list1", i, { maxLength: 4 })),
        );
        expect(await adapter.getList("list1")).toEqual([8, 9, 10, 11]);
      });

      it("respects TTL on lists", async () => {
        await adapter.appendToList("list1", { id: 1 }, { ttlMs: 10 });
        await sleep(20);
        expect(await adapter.getList("list1")).toEqual([]);
      });

      it("refreshes TTL on subsequent appends", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          await adapter.appendToList("list1", { id: 1 }, { ttlMs: 50 });
          vi.setSystemTime(start + 30);
          await adapter.appendToList("list1", { id: 2 }, { ttlMs: 50 });
          vi.setSystemTime(start + 60);
          expect(await adapter.getList("list1")).toEqual([{ id: 1 }, { id: 2 }]);
          vi.setSystemTime(start + 81);
          expect(await adapter.getList("list1")).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps lists isolated by key", async () => {
        await adapter.appendToList("list-a", "a");
        await adapter.appendToList("list-b", "b");
        expect(await adapter.getList("list-a")).toEqual(["a"]);
        expect(await adapter.getList("list-b")).toEqual(["b"]);
      });

      it("starts fresh after an expired list", async () => {
        await adapter.appendToList("list1", { id: 1 }, { ttlMs: 10 });
        await sleep(20);
        await adapter.appendToList("list1", { id: 2 });
        expect(await adapter.getList("list1")).toEqual([{ id: 2 }]);
      });
    });

    describe("enqueue / dequeue / queueDepth", () => {
      it("enqueues and dequeues a single entry", async () => {
        const queued = entry("m1");
        expect(await adapter.enqueue("thread1", queued, 10)).toBe(1);
        expect(await adapter.dequeue("thread1")).toEqual(queued);
      });

      it("returns null when dequeuing from an empty queue", async () => {
        expect(await adapter.dequeue("thread1")).toBeNull();
      });

      it("returns 0 depth for an empty queue", async () => {
        expect(await adapter.queueDepth("thread1")).toBe(0);
      });

      it("dequeues in FIFO order", async () => {
        for (const id of ["m1", "m2", "m3"]) {
          await adapter.enqueue("thread1", entry(id), 10);
        }
        expect(await adapter.queueDepth("thread1")).toBe(3);
        expect(ids(await drain(adapter, "thread1"))).toEqual(["m1", "m2", "m3"]);
        expect(await adapter.queueDepth("thread1")).toBe(0);
      });

      it("trims to maxSize keeping newest entries", async () => {
        for (let i = 1; i <= 5; i++) {
          expect(await adapter.enqueue("thread1", entry(`m${i}`), 3)).toBe(Math.min(i, 3));
        }
        expect(await adapter.queueDepth("thread1")).toBe(3);
        expect(ids(await drain(adapter, "thread1"))).toEqual(["m3", "m4", "m5"]);
      });

      it("handles a maxSize of 1", async () => {
        for (const id of ["m1", "m2", "m3"]) {
          await adapter.enqueue("thread1", entry(id), 1);
        }
        expect(await adapter.queueDepth("thread1")).toBe(1);
        expect(ids(await drain(adapter, "thread1"))).toEqual(["m3"]);
      });

      it("keeps the newest entries under concurrent enqueues", async () => {
        await Promise.all(
          Array.from({ length: 12 }, (_, i) => adapter.enqueue("thread1", entry(`m${i}`), 4)),
        );
        expect(ids(await drain(adapter, "thread1"))).toEqual(["m8", "m9", "m10", "m11"]);
      });

      it("hands each entry to exactly one of many concurrent consumers", async () => {
        for (let i = 0; i < 6; i++) {
          await adapter.enqueue("thread1", entry(`m${i}`), 10);
        }
        const results = await Promise.all(
          Array.from({ length: 12 }, () => adapter.dequeue("thread1")),
        );
        expect(ids(results.filter(Boolean)).sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
      });

      it("keeps queues isolated by thread", async () => {
        await adapter.enqueue("thread-a", entry("a1"), 10);
        await adapter.enqueue("thread-b", entry("b1"), 10);
        expect(await adapter.queueDepth("thread-a")).toBe(1);
        expect(ids([await adapter.dequeue("thread-a")])).toEqual(["a1"]);
        expect(ids([await adapter.dequeue("thread-b")])).toEqual(["b1"]);
      });
    });

    describe("keyspaces", () => {
      it("does not mix lists, queues, locks and subscriptions sharing a name", async () => {
        await adapter.appendToList("x", "item");
        await adapter.enqueue("x", entry("m1"), 10);
        await adapter.subscribe("x");
        await acquired(adapter, "x");
        expect(await adapter.getList("x")).toEqual(["item"]);
        expect(await adapter.queueDepth("x")).toBe(1);
      });
    });
  });
}
