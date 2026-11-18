import { ConsoleLogger } from "chat";
import { createDynamoDbState } from "../dynamodb-state/index.js";
import { createGitHubDispatcher } from "./github.js";
import { wrapHandler } from "./http.js";
import { createSsmParameterStore, GITHUB_TOKEN_PARAMETER } from "./parameters.js";
import { createReceiver } from "./receiver.js";

async function buildReceiver() {
  const params = createSsmParameterStore();
  const token = await params.get(GITHUB_TOKEN_PARAMETER);
  if (!token) throw new Error(`missing SSM parameter ${GITHUB_TOKEN_PARAMETER}`);
  const tableName = process.env.STATE_TABLE_NAME;
  if (!tableName) throw new Error("STATE_TABLE_NAME is not set");
  return createReceiver({
    params,
    stateFor: (keyPrefix) => createDynamoDbState({ tableName, keyPrefix }),
    dispatcher: createGitHubDispatcher(token),
    logger: new ConsoleLogger("info"),
  });
}

let receiver: ReturnType<typeof buildReceiver> | undefined;

export const handler = wrapHandler(async (request) => {
  receiver ??= buildReceiver().catch((error) => {
    receiver = undefined;
    throw error;
  });
  return (await receiver)(request);
});
