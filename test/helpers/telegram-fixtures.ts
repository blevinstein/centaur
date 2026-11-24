import { vi } from "vitest";
import { GARDEN_BOT } from "./receiver-fixtures.js";

const sentResult = (
  body: { chat_id?: string | number; message_thread_id?: number },
  id: number,
) => ({
  message_id: id,
  date: 0,
  chat: { id: body.chat_id ?? 1, type: "private" },
  ...(body.message_thread_id === undefined ? {} : { message_thread_id: body.message_thread_id }),
});

/** Answers `getMe` and echoes each `sendMessage` target back in a result with a fresh message ID. */
export function stubTelegram() {
  const sent: { chat_id: string | number; text: string }[] = [];
  let messageId = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/sendMessage")) sent.push(body);
      const result = url.endsWith("/getMe")
        ? { id: 1, is_bot: true, first_name: "Garden", username: "garden_bot" }
        : sentResult(body, ++messageId);
      return new Response(JSON.stringify({ ok: true, result }));
    }),
  );
  return sent;
}

export const telegramUpdate = (
  message: {
    chatId: number;
    chatType: string;
    userId: number;
    text: string;
    topic?: number;
    date?: number;
    messageId?: number;
  },
  bot = GARDEN_BOT,
) =>
  new Request(`https://example.test/telegram/${bot.name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": bot.webhookSecret,
    },
    body: JSON.stringify({
      update_id: message.messageId ?? 1,
      message: {
        message_id: message.messageId ?? 10,
        date: message.date ?? 1,
        chat: { id: message.chatId, type: message.chatType },
        ...(message.topic === undefined
          ? {}
          : { message_thread_id: message.topic, is_topic_message: true }),
        from: { id: message.userId, is_bot: false, first_name: "Pat" },
        text: message.text,
        ...(message.text.startsWith("/")
          ? {
              entities: [
                { type: "bot_command", offset: 0, length: /^\/\w+/.exec(message.text)?.[0].length },
              ],
            }
          : {}),
      },
    }),
  });
