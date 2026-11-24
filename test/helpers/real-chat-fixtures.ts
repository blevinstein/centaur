import { createDynamoDBState } from "@blevinstein/chat-state-dynamodb";
import type { ChatAccess } from "../../src/cli/chat-access.js";
import { createChat } from "../../src/lambda/chat.js";
import { botStatePrefix } from "../../src/lambda/registry.js";
import { createFreshTable } from "./dynamodb-local.js";
import { fakeLogger, GARDEN_BOT } from "./receiver-fixtures.js";
import { stubTelegram, telegramUpdate } from "./telegram-fixtures.js";

export interface IncomingTelegramMessage {
  text: string;
  chatId?: number;
  userId?: number;
  topic?: number;
  /** Seconds since the epoch; defaults to now. */
  date?: number;
}

/**
 * The real `Chat` for the bot `garden` over the real DynamoDB state adapter on DynamoDB Local, with
 * the Telegram HTTP API stubbed. `receive` delivers a webhook update, so history is stored exactly as
 * the receiver stores it.
 */
export async function realTelegramChat() {
  const sent = stubTelegram();
  const table = await createFreshTable();
  const createState = (keyPrefix: string) => createDynamoDBState({ ...table, keyPrefix });
  const chat = createChat({
    bot: GARDEN_BOT,
    botState: createState(botStatePrefix(GARDEN_BOT.name)),
    logger: fakeLogger(),
  });
  await chat.initialize();
  let nextMessageId = 10;
  const receive = async ({
    text,
    chatId = -100500,
    userId = 1001,
    topic,
    date = Math.floor(Date.now() / 1000),
  }: IncomingTelegramMessage) => {
    const tasks: Promise<unknown>[] = [];
    await chat.webhooks.telegram?.(
      telegramUpdate({
        messageId: ++nextMessageId,
        chatId,
        chatType: "supergroup",
        userId,
        text,
        date,
        ...(topic ? { topic } : {}),
      }),
      { waitUntil: (task) => void tasks.push(task) },
    );
    await Promise.all(tasks);
  };
  const access: ChatAccess = {
    env: {},
    createState: (_table, keyPrefix) => createState(keyPrefix),
    chatFor: (bot) =>
      createChat({ bot, botState: createState(botStatePrefix(bot.name)), logger: fakeLogger() }),
  };
  return { chat, receive, sent, access };
}
