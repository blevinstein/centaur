import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { ConsoleLogger } from "chat";
import { createDynamoDbState } from "../dynamodb-state/index.js";
import { createAttachmentStore, createS3ObjectStore } from "./attachments.js";
import { createChat } from "./chat.js";
import { createGitHubDispatcher } from "./github.js";
import { wrapHandler } from "./http.js";
import { createGitHubOidcVerifier } from "./oidc.js";
import {
  createSsmParameterStore,
  FUNCTION_URL_PARAMETER,
  GITHUB_TOKEN_PARAMETER,
} from "./parameters.js";
import { createPoster } from "./poster.js";
import { createReceiver } from "./receiver.js";
import { createTelegramApi } from "./telegram.js";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function memoizeAsync<T>(build: () => Promise<T>) {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= build().catch((error) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

const logger = new ConsoleLogger("info");

const buildAttachments = () =>
  createAttachmentStore(createS3ObjectStore(requiredEnv("SESSION_BUCKET_NAME")));

async function buildReceiver() {
  const params = createSsmParameterStore();
  const token = await params.get(GITHUB_TOKEN_PARAMETER);
  if (!token) throw new Error(`missing SSM parameter ${GITHUB_TOKEN_PARAMETER}`);
  const tableName = requiredEnv("STATE_TABLE_NAME");
  return createReceiver({
    params,
    stateFor: (keyPrefix) => createDynamoDbState({ tableName, keyPrefix }),
    attachments: buildAttachments(),
    dispatcher: createGitHubDispatcher(token),
    logger,
  });
}

async function buildPoster() {
  const tableName = requiredEnv("STATE_TABLE_NAME");
  const params = createSsmParameterStore();
  const functionUrl = await params.get(FUNCTION_URL_PARAMETER);
  if (!functionUrl) throw new Error(`missing SSM parameter ${FUNCTION_URL_PARAMETER}`);
  return createPoster({
    params,
    stateFor: (keyPrefix) => createDynamoDbState({ tableName, keyPrefix }),
    chatFor: (bot, botState) => createChat({ bot, botState, logger }),
    attachments: buildAttachments(),
    telegram: createTelegramApi(),
    oidc: createGitHubOidcVerifier({
      owner: requiredEnv("GITHUB_OWNER"),
      audience: requiredEnv("OIDC_AUDIENCE"),
    }),
    functionUrl,
    logger,
  });
}

const receiver = memoizeAsync(buildReceiver);
const poster = memoizeAsync(buildPoster);
const handleWebhook = wrapHandler(async (request) => (await receiver())(request));

export const handler = async (
  event: APIGatewayProxyEventV2 | { operation: string },
  context?: Context,
) => ("operation" in event ? (await poster())(event) : handleWebhook(event, context));
