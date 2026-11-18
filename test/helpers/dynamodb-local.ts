import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { inject } from "vitest";
import { createDynamoDbState } from "../../src/dynamodb-state/index.js";
import { stateTableInput, TTL_ATTRIBUTE } from "../../src/dynamodb-state/table.js";

export async function createFreshTable() {
  const tableName = `state-${randomUUID()}`;
  const client = new DynamoDBClient({
    endpoint: inject("dynamodbEndpoint"),
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(new CreateTableCommand(stateTableInput(tableName)));
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
    }),
  );
  return { tableName, client: DynamoDBDocumentClient.from(client) };
}

export async function createAdapterOnFreshTable() {
  return createDynamoDbState(await createFreshTable());
}

export async function scanItems({
  client,
  tableName,
}: Awaited<ReturnType<typeof createFreshTable>>): Promise<Record<string, unknown>[]> {
  const { Items } = await client.send(
    new ScanCommand({ TableName: tableName, ConsistentRead: true }),
  );
  return Items ?? [];
}
