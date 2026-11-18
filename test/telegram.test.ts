import { describe, expect, it, vi } from "vitest";
import { createTelegramApi } from "../src/lambda/telegram.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Telegram API client", () => {
  it("calls setWebhook with the URL and secret token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: true }));

    await createTelegramApi(fetchImpl).setWebhook(
      "123:abc",
      "https://x.test/telegram/garden",
      "sec",
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/setWebhook");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://x.test/telegram/garden",
      secret_token: "sec",
    });
  });

  it("returns the new topic's message_thread_id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_thread_id: 55, name: "Week 12" } }),
    );

    const id = await createTelegramApi(fetchImpl).createForumTopic("123:abc", "-100500", "Week 12");

    expect(id).toBe(55);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "-100500", name: "Week 12" });
  });

  it("reports Telegram's description without leaking the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, description: "Bad Request: not enough rights" }, 400),
    );

    const failure = createTelegramApi(fetchImpl).createForumTopic("123:abc", "-1", "t");

    await expect(failure).rejects.toThrow(
      "createForumTopic failed with HTTP 400: Bad Request: not enough rights",
    );
    await expect(failure).rejects.not.toThrow(/123:abc/);
  });
});
