import { createMemoryState } from "@chat-adapter/state-memory";
import { expect, vi } from "vitest";
import { createChat } from "../../src/lambda/chat.js";
import type { HistoryWindow } from "../../src/lambda/history-window.js";
import { fakeLogger, GARDEN_BOT, GROUP_CHAT_ID } from "./receiver-fixtures.js";

const SENT_RESULT = { message_id: 1, date: 0, chat: { id: 1, type: "private" } };

export const HISTORY_ENV = {
  HISTORY_MAX_MESSAGES: "100",
  HISTORY_TTL_DAYS: "7",
};

/** Delivers one Telegram group message through `createChat` and returns the options the SDK passed to `appendToList`. */
export async function historyAppendOptions(history?: HistoryWindow) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            ok: true,
            result: url.endsWith("/getMe")
              ? { id: 1, is_bot: true, first_name: "Garden", username: "garden_bot" }
              : SENT_RESULT,
          }),
        ),
    ),
  );
  const botState = createMemoryState();
  const appendToList = vi.spyOn(botState, "appendToList");
  const chat = createChat({
    bot: GARDEN_BOT,
    botState,
    logger: fakeLogger(),
    ...(history ? { history } : {}),
  });
  const response = await chat.webhooks.telegram?.(
    new Request("https://example.test/telegram/garden", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": GARDEN_BOT.webhookSecret,
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10,
          date: 1,
          chat: { id: Number(GROUP_CHAT_ID), type: "supergroup", title: "Garden Club" },
          from: { id: 1001, is_bot: false, first_name: "Pat" },
          text: "hello",
        },
      }),
    }),
    { waitUntil: (task) => void task },
  );
  await vi.waitFor(() => expect(appendToList).toHaveBeenCalled());
  return {
    status: response?.status,
    options: appendToList.mock.calls.map(([, , options]) => options),
  };
}
