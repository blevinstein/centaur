import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import { ConsoleLogger, type StateAdapter } from "chat";
import { createChat } from "../lambda/chat.js";
import type { PosterChat } from "../lambda/poster.js";
import type { Bot } from "../lambda/registry.js";

/** What `chat tail` needs from AWS and the chat adapters, so tests can supply their own. */
export interface ChatAccess {
  env: NodeJS.ProcessEnv;
  createState(tableName: string, keyPrefix: string): StateAdapter;
  chatFor(bot: Bot, state: StateAdapter): PosterChat;
}

export function createChatAccess(env: NodeJS.ProcessEnv = process.env): ChatAccess {
  const logger = new ConsoleLogger("error");
  return {
    env,
    createState: (tableName, keyPrefix) =>
      createDynamoDBState({ tableName, client: new DynamoDBClient({}), keyPrefix }),
    chatFor: (bot, botState) => createChat({ bot, botState, logger }),
  };
}
