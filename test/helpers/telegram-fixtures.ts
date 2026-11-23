import { vi } from "vitest";
import { GARDEN_BOT } from "./receiver-fixtures.js";

const SENT_RESULT = { message_id: 1, date: 0, chat: { id: 1, type: "private" } };

export function stubTelegram() {
  const sent: { chat_id: string | number; text: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/sendMessage")) sent.push(body);
      const result = url.endsWith("/getMe")
        ? { id: 1, is_bot: true, first_name: "Garden", username: "garden_bot" }
        : SENT_RESULT;
      return new Response(JSON.stringify({ ok: true, result }));
    }),
  );
  return sent;
}

export const telegramUpdate = (
  message: { chatId: number; chatType: string; userId: number; text: string },
  bot = GARDEN_BOT,
) =>
  new Request(`https://example.test/telegram/${bot.name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": bot.webhookSecret,
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        chat: { id: message.chatId, type: message.chatType },
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
