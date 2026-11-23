import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiver } from "../src/lambda/receiver.js";
import { writeRegistryEntry } from "../src/lambda/registry.js";
import {
  ALLOWED_USER_ID,
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeParameterStore,
  GARDEN_BOT,
  PARAMETERS,
} from "./helpers/receiver-fixtures.js";

const PHOTO = [
  { file_id: "small", file_unique_id: "s", width: 90, height: 60, file_size: 1000 },
  { file_id: "large", file_unique_id: "l", width: 1280, height: 960, file_size: 90000 },
];

async function photoUpdate(extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const result = url.endsWith("/getMe")
        ? { id: 1, is_bot: true, first_name: "Garden", username: "garden_bot" }
        : { message_id: 1, date: 0, chat: { id: 1, type: "private" } };
      return new Response(JSON.stringify({ ok: true, result }));
    }),
  );
  const params = fakeParameterStore({
    ...PARAMETERS,
    [`/centaur/bots/garden/platforms/telegram/approved-users/${ALLOWED_USER_ID}`]: "{}",
  });
  const attachments = fakeAttachments();
  const dispatcher = fakeDispatcher();
  const state = createMemoryState();
  await state.connect();
  await writeRegistryEntry(state, "garden", {});
  const handler = await createReceiver({
    params,
    createState: () => state,
    attachments,
    dispatcher,
    logger: fakeLogger(),
  });
  const response = await handler(
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
          chat: { id: Number(ALLOWED_USER_ID), type: "private" },
          from: { id: Number(ALLOWED_USER_ID), is_bot: false, first_name: "Pat" },
          photo: PHOTO,
          ...extra,
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  return { attachments, dispatcher };
}

afterEach(() => vi.unstubAllGlobals());

describe("a Telegram photo through the receiver", () => {
  it.each([
    ["without a caption", {}],
    ["with a caption", { caption: "what is eating these leaves?" }],
  ])("reaches the attachment store %s", async (_name, extra) => {
    const { attachments, dispatcher } = await photoUpdate(extra);

    expect(attachments.save).toHaveBeenCalledOnce();
    const [bot, message] = attachments.save.mock.calls[0] ?? [];
    expect(bot).toBe("garden");
    expect(message?.attachments).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
    ]);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});
