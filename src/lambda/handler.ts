import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { ConsoleLogger } from "chat";
import { createAttachmentStore, createS3ObjectStore } from "./attachments.js";
import { createCachedParameterStore } from "./cached-parameters.js";
import { createChat } from "./chat.js";
import { readFailureNoticeIntervalMs } from "./dispatch-failure-notice.js";
import { createGitHubDispatcher, type RepositoryDispatcher } from "./github.js";
import { readHistoryWindow } from "./history-window.js";
import { wrapHandler } from "./http.js";
import { readBundledMcpPolicy } from "./mcp-policy.js";
import { createGitHubOidcVerifier } from "./oidc.js";
import {
  createSsmParameterStore,
  FUNCTION_URL_PARAMETER,
  GITHUB_TOKEN_PARAMETER,
  type ParameterStore,
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

const stateCreator = (tableName: string) => {
  const client = new DynamoDBClient({});
  return (keyPrefix: string) => createDynamoDBState({ tableName, client, keyPrefix });
};

const buildAttachments = () =>
  createAttachmentStore(createS3ObjectStore(requiredEnv("SESSION_BUCKET_NAME")));

async function buildDispatcher(params: ParameterStore) {
  const token = await params.get(GITHUB_TOKEN_PARAMETER);
  if (!token) throw new Error(`missing SSM parameter ${GITHUB_TOKEN_PARAMETER}`);
  return createGitHubDispatcher(token);
}

/** Reads the token on the first dispatch, so a poster that never resumes a thread never needs it. */
function lazyDispatcher(params: ParameterStore): RepositoryDispatcher {
  const dispatcher = memoizeAsync(() => buildDispatcher(params));
  return { dispatch: async (...args) => (await dispatcher()).dispatch(...args) };
}

async function buildReceiver() {
  const params = createSsmParameterStore();
  const tableName = requiredEnv("STATE_TABLE_NAME");
  return createReceiver({
    params: createCachedParameterStore(params),
    createState: stateCreator(tableName),
    attachments: buildAttachments(),
    dispatcher: await buildDispatcher(params),
    logger,
    history: readHistoryWindow(),
    failureNoticeIntervalMs: readFailureNoticeIntervalMs(),
  });
}

async function buildPoster() {
  const tableName = requiredEnv("STATE_TABLE_NAME");
  const params = createSsmParameterStore();
  const functionUrl = await params.get(FUNCTION_URL_PARAMETER);
  if (!functionUrl) throw new Error(`missing SSM parameter ${FUNCTION_URL_PARAMETER}`);
  const history = readHistoryWindow();
  return createPoster({
    params,
    createState: stateCreator(tableName),
    chatFor: (bot, botState) => createChat({ bot, botState, logger, history }),
    attachments: buildAttachments(),
    telegram: createTelegramApi(),
    dispatcher: lazyDispatcher(params),
    oidc: createGitHubOidcVerifier({
      owner: requiredEnv("GITHUB_OWNER"),
      audience: requiredEnv("OIDC_AUDIENCE"),
    }),
    globalMcpPolicy: readBundledMcpPolicy(),
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
