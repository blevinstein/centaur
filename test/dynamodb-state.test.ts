import { describe, expect, it } from "vitest";
import { createDynamoDbState } from "../src/dynamodb-state/index.js";
import { createAdapterOnFreshTable, createFreshTable } from "./helpers/dynamodb-local.js";
import { defineStateAdapterSuite } from "./helpers/state-adapter-suite.js";

defineStateAdapterSuite("dynamodb-state (DynamoDB Local)", createAdapterOnFreshTable);

describe("dynamodb-state key prefix", () => {
  it("isolates every kind of key between prefixes sharing a table", async () => {
    const table = await createFreshTable();
    const first = createDynamoDbState({ ...table, keyPrefix: "bot:a:" });
    const second = createDynamoDbState({ ...table, keyPrefix: "bot:b:" });

    await first.set("dedupe:telegram:1", true);
    await first.subscribe("telegram:1:2");
    await first.setIfNotExists("k", 1);

    expect(await second.get("dedupe:telegram:1")).toBeNull();
    expect(await second.isSubscribed("telegram:1:2")).toBe(false);
    expect(await second.setIfNotExists("k", 2)).toBe(true);
    expect(await first.get("dedupe:telegram:1")).toBe(true);
  });
});
