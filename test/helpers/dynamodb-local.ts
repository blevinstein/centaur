import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_DEFINITION, TTL_ATTRIBUTE } from "@blevinstein/chat-state-dynamodb";
import { inject } from "vitest";

export async function createFreshTable() {
  const tableName = `state-${randomUUID()}`;
  const client = new DynamoDBClient({
    endpoint: inject("dynamodbEndpoint"),
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(new CreateTableCommand({ ...TABLE_DEFINITION, TableName: tableName }));
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
    }),
  );
  return { tableName, client };
}

export async function scanItems({
  client,
  tableName,
}: Awaited<ReturnType<typeof createFreshTable>>): Promise<Record<string, unknown>[]> {
  const { Items } = await DynamoDBDocumentClient.from(client).send(
    new ScanCommand({ TableName: tableName, ConsistentRead: true }),
  );
  return Items ?? [];
}
