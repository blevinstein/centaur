/**
 * DynamoDB-backed Chat SDK `StateAdapter` on a single pay-per-request table.
 *
 * Keys are `pk` (string) and `sk` (string). Attributes: `value` (JSON string), `token`,
 * `expiresAt` (epoch ms, filtered at read time because DynamoDB TTL deletion lags by up to days)
 * and `ttl` (epoch seconds, the table's TTL attribute, for physical cleanup).
 *
 *   kv:<key>        / 0                  cached value
 *   lock:<threadId> / 0                  token, expiresAt
 *   sub:<threadId>  / 0                  subscription marker
 *   list:<key>      / 0                  header holding the list-wide expiresAt
 *   list:<key>      / 1#<ms>#<uuid>      one item per entry, ordered by sk
 *   queue:<threadId>/ 1#<ms>#<uuid>      one item per queued entry, ordered by sk
 *
 * Atomic: get/set/delete, setIfNotExists, acquireLock, extendLock, releaseLock, dequeue (each is a
 * single conditional write; dequeue retries when another consumer wins the oldest entry).
 * Best effort: appendToList and enqueue write their entry, then trim the oldest entries in a
 * second step. Concurrent trims are idempotent and only ever remove entries older than the newest
 * `maxLength`, so the newest entries are never lost; the visible length can briefly exceed the
 * limit. Entries from different processes within the same millisecond order arbitrarily.
 */
import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DeleteCommandInput,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Lock, QueueEntry, StateAdapter } from "chat";

type Item = Record<string, unknown>;

const SINGLETON_SK = "0";
const ENTRY_SK_PREFIX = "1#";
const FREE_OR_EXPIRED = "attribute_not_exists(pk) OR expiresAt <= :now";

export interface DynamoDbStateOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoDbStateAdapter implements StateAdapter {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private lastSortMs = 0;

  constructor({ tableName, client }: DynamoDbStateOptions) {
    this.tableName = tableName;
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async subscribe(threadId: string): Promise<void> {
    await this.putItem({ pk: pk("sub", threadId), sk: SINGLETON_SK });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.deleteItem(pk("sub", threadId), SINGLETON_SK);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (await this.getItem(pk("sub", threadId))) !== undefined;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const lock: Lock = { threadId, token: randomUUID(), expiresAt: Date.now() + ttlMs };
    const acquired = await this.ifConditionHolds(() =>
      this.putItem(
        { pk: pk("lock", threadId), sk: SINGLETON_SK, token: lock.token },
        lock.expiresAt,
        true,
      ),
    );
    return acquired ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const expiresAt = Date.now() + ttlMs;
    return this.ifConditionHolds(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk("lock", lock.threadId), sk: SINGLETON_SK },
          UpdateExpression: "SET expiresAt = :expiresAt, #ttl = :ttl",
          ConditionExpression: "#token = :token AND expiresAt > :now",
          ExpressionAttributeNames: { "#ttl": "ttl", "#token": "token" },
          ExpressionAttributeValues: {
            ":expiresAt": expiresAt,
            ":ttl": toTtlSeconds(expiresAt),
            ":token": lock.token,
            ":now": Date.now(),
          },
        }),
      ),
    );
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.ifConditionHolds(() =>
      this.deleteItem(pk("lock", lock.threadId), SINGLETON_SK, {
        ConditionExpression: "#token = :token",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: { ":token": lock.token },
      }),
    );
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.deleteItem(pk("lock", threadId), SINGLETON_SK);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getItem(pk("kv", key));
    return item && !isExpired(item) ? (JSON.parse(item.value as string) as T) : null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.putItem(
      { pk: pk("kv", key), sk: SINGLETON_SK, value: JSON.stringify(value) },
      expiryFrom(ttlMs),
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.ifConditionHolds(() =>
      this.putItem(
        { pk: pk("kv", key), sk: SINGLETON_SK, value: JSON.stringify(value) },
        expiryFrom(ttlMs),
        true,
      ),
    );
  }

  async delete(key: string): Promise<void> {
    await this.deleteItem(pk("kv", key), SINGLETON_SK);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const listPk = pk("list", key);
    const sk = this.nextEntrySortKey();
    const expiresAt = expiryFrom(options?.ttlMs);
    const previousHeader = await this.putItem({ pk: listPk, sk: SINGLETON_SK }, expiresAt);
    await this.pushEntry(
      listPk,
      sk,
      value,
      expiresAt,
      options?.maxLength,
      previousHeader !== undefined && isExpired(previousHeader),
    );
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const [header, ...entries] = await this.queryItems(pk("list", key));
    if (!header || header.sk !== SINGLETON_SK || isExpired(header)) {
      return [];
    }
    return entries.map((entry) => JSON.parse(entry.value as string) as T);
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return this.pushEntry(
      pk("queue", threadId),
      this.nextEntrySortKey(),
      entry,
      entry.expiresAt,
      maxSize,
    );
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const queuePk = pk("queue", threadId);
    for (;;) {
      const [oldest] = await this.queryItems(queuePk, 1);
      if (!oldest) {
        return null;
      }
      const won = await this.ifConditionHolds(() =>
        this.deleteItem(queuePk, oldest.sk as string, {
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
      if (won) {
        return JSON.parse(oldest.value as string) as QueueEntry;
      }
    }
  }

  async queueDepth(threadId: string): Promise<number> {
    return (await this.queryItems(pk("queue", threadId))).length;
  }

  /**
   * Writes one entry, then deletes entries beyond `maxLength` (oldest first), or all entries but
   * the new one when `replaceExisting` is set. Returns the number of entries kept.
   */
  private async pushEntry(
    partitionKey: string,
    sk: string,
    value: unknown,
    expiresAt: number | undefined,
    maxLength?: number,
    replaceExisting = false,
  ): Promise<number> {
    await this.putItem({ pk: partitionKey, sk, value: JSON.stringify(value) }, expiresAt);
    const entries = (await this.queryItems(partitionKey)).filter(
      (item) => item.sk !== SINGLETON_SK,
    );
    const keep = replaceExisting ? 1 : (maxLength ?? entries.length);
    const stale = entries.slice(0, Math.max(0, entries.length - keep));
    await Promise.all(stale.map((item) => this.deleteItem(partitionKey, item.sk as string)));
    return entries.length - stale.length;
  }

  private nextEntrySortKey(): string {
    this.lastSortMs = Math.max(Date.now(), this.lastSortMs + 1);
    return `${ENTRY_SK_PREFIX}${String(this.lastSortMs).padStart(15, "0")}#${randomUUID()}`;
  }

  private async putItem(
    item: Item & { pk: string; sk: string },
    expiresAt?: number,
    onlyIfFree = false,
  ) {
    const { Attributes } = await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: expiresAt === undefined ? item : { ...item, expiresAt, ttl: toTtlSeconds(expiresAt) },
        ReturnValues: "ALL_OLD",
        ...(onlyIfFree && {
          ConditionExpression: FREE_OR_EXPIRED,
          ExpressionAttributeValues: { ":now": Date.now() },
        }),
      }),
    );
    return Attributes;
  }

  private async getItem(partitionKey: string): Promise<Item | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionKey, sk: SINGLETON_SK },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  private async deleteItem(
    partitionKey: string,
    sk: string,
    condition: Pick<
      DeleteCommandInput,
      "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"
    > = {},
  ): Promise<void> {
    await this.client.send(
      new DeleteCommand({ TableName: this.tableName, Key: { pk: partitionKey, sk }, ...condition }),
    );
  }

  private async queryItems(partitionKey: string, limit?: number): Promise<Item[]> {
    const items: Item[] = [];
    let startKey: Item | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": partitionKey },
          ConsistentRead: true,
          ...(startKey && { ExclusiveStartKey: startKey }),
          ...(limit && { Limit: limit }),
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = limit ? undefined : page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  private async ifConditionHolds(write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
}

export function createDynamoDbState(options: DynamoDbStateOptions): DynamoDbStateAdapter {
  return new DynamoDbStateAdapter(options);
}

function pk(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function expiryFrom(ttlMs?: number): number | undefined {
  return ttlMs ? Date.now() + ttlMs : undefined;
}

function toTtlSeconds(expiresAtMs: number): number {
  return Math.ceil(expiresAtMs / 1000);
}

function isExpired(item: Item): boolean {
  return typeof item.expiresAt === "number" && item.expiresAt <= Date.now();
}
