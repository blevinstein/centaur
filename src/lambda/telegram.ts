export interface TelegramMe {
  username: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramApi {
  getMe(token: string): Promise<TelegramMe>;
  setWebhook(token: string, url: string, secretToken: string): Promise<void>;
  createForumTopic(token: string, chatId: string, name: string): Promise<number>;
  reopenForumTopic(token: string, chatId: string, topicId: number): Promise<void>;
}

export const WEBHOOK_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "message_reaction",
];

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export function createTelegramApi(fetchImpl = fetch): TelegramApi {
  const call = async <T>(token: string, method: string, params: Record<string, unknown>) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await response.json().catch(() => ({}))) as BotApiResponse<T>;
    if (!response.ok || !body.ok) {
      throw new Error(
        `Telegram ${method} failed with HTTP ${response.status}: ${body.description ?? "no description"}`,
      );
    }
    return body.result as T;
  };
  return {
    getMe: (token) => call<TelegramMe>(token, "getMe", {}),
    async setWebhook(token, url, secretToken) {
      await call(token, "setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: WEBHOOK_UPDATES,
      });
    },
    async createForumTopic(token, chatId, name) {
      const topic = await call<{ message_thread_id: number }>(token, "createForumTopic", {
        chat_id: chatId,
        name,
      });
      return topic.message_thread_id;
    },
    async reopenForumTopic(token, chatId, topicId) {
      await call(token, "reopenForumTopic", { chat_id: chatId, message_thread_id: topicId });
    },
  };
}
