import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import { describe, expect, it } from "vitest";
import { connectState } from "../src/lambda/state.js";
import { createFreshTable } from "./helpers/dynamodb-local.js";
import { CONNECT_FAILURE, strictStates } from "./helpers/strict-state.js";

describe("connectState", () => {
  it("returns an adapter that is usable immediately", async () => {
    const strict = strictStates();
    const state = await connectState(strict.createState("bot:a:"));

    await state.set("k", 1);

    expect(await state.get("k")).toBe(1);
    expect(strict.connects("bot:a:")).toBe(1);
  });

  it("rejects with the connect error", async () => {
    const strict = strictStates({ failConnects: { "": 1 } });

    await expect(connectState(strict.createState(""))).rejects.toThrow(CONNECT_FAILURE);
  });

  it("leaves the DynamoDB adapter usable and survives Chat's own connect()", async () => {
    const table = await createFreshTable();
    const state = await connectState(createDynamoDBState({ ...table, keyPrefix: "bot:a:" }));

    await state.set("k", { n: 1 });
    await state.connect();

    expect(await state.get("k")).toEqual({ n: 1 });
  });

  it("rejects when the table is missing", async () => {
    const table = await createFreshTable();
    const state = createDynamoDBState({
      tableName: "no-such-table",
      client: table.client,
      keyPrefix: "",
    });

    await expect(connectState(state)).rejects.toThrow();
  });
});
