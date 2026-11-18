import { execFileSync } from "node:child_process";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import type { TestProject } from "vitest/node";

const IMAGE = "amazon/dynamodb-local:3.3.2";

declare module "vitest" {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

async function waitUntilReady(endpoint: string): Promise<void> {
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (error) {
      if (attempt >= 60) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export default async function setup(project: TestProject) {
  const configured = process.env.DYNAMODB_ENDPOINT;
  if (configured) {
    project.provide("dynamodbEndpoint", configured);
    return;
  }
  const container = docker(
    "run",
    "-d",
    "--rm",
    "-p",
    "127.0.0.1::8000",
    IMAGE,
    "-jar",
    "DynamoDBLocal.jar",
    "-inMemory",
  );
  const port = docker("port", container, "8000/tcp").split("\n")[0]?.split(":").pop();
  const endpoint = `http://127.0.0.1:${port}`;
  project.provide("dynamodbEndpoint", endpoint);
  await waitUntilReady(endpoint);
  return () => {
    docker("stop", container);
  };
}
