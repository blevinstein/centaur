import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUESTED_TEXT } from "../src/lambda/access-requests.js";
import { encodeClaim } from "../src/lambda/admin-claim-record.js";
import { CLAIMED_TEXT, INVALID_CODE_TEXT } from "../src/lambda/admin-claims.js";
import { createReceiver } from "../src/lambda/receiver.js";
import { writeRegistryEntry } from "../src/lambda/registry.js";
import {
  ADMIN_ID,
  ADMIN_PARAMETER,
  CLAIM_CODE,
  CLAIM_PARAMETER,
} from "./helpers/access-fixtures.js";
import {
  ALLOWED_USER_ID,
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeParameterStore,
  GARDEN_BOT,
  PARAMETERS,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";
import { strictStates } from "./helpers/strict-state.js";

const SENT_RESULT = { message_id: 1, date: 0, chat: { id: 1, type: "private" } };

function stubTelegram() {
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

async function startUpdate(
  userId: string,
  text: string,
  { claim, strict }: { claim?: Date | undefined; strict?: ReturnType<typeof strictStates> } = {},
) {
  const params = fakeParameterStore({
    ...PARAMETERS,
    [ADMIN_PARAMETER]: ADMIN_ID,
    "/centaur/bots/garden/platforms/telegram/approved-users/1001": "{}",
    ...(claim ? { [CLAIM_PARAMETER]: encodeClaim("garden", CLAIM_CODE, claim) } : {}),
  });
  const dispatcher = fakeDispatcher();
  const state = strict?.inner("") ?? createMemoryState();
  await state.connect();
  await writeRegistryEntry(state, "garden", {});
  const handler = await createReceiver({
    params,
    createState: strict?.createState ?? (() => state),
    attachments: fakeAttachments(),
    dispatcher,
    logger: fakeLogger(),
  });
  const command = /^\/\w+/.exec(text) as RegExpExecArray;
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
          chat: { id: Number(userId), type: "private" },
          from: { id: Number(userId), is_bot: false, first_name: "Pat" },
          text,
          entities: [{ type: "bot_command", offset: 0, length: command[0].length }],
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  return { params, dispatcher };
}

const inFuture = () => new Date(Date.now() + 60_000);
const inPast = () => new Date(Date.now() - 60_000);

afterEach(() => vi.unstubAllGlobals());

describe("/start in a Telegram DM", () => {
  it.each([
    ["a bare /start", "/start", undefined],
    ["/start with a code and no pending claim", `/start ${CLAIM_CODE}`, undefined],
    ["/start with a code and an expired claim", `/start ${CLAIM_CODE}`, inPast()],
  ])("lets an unknown user request access with %s", async (_name, text, claim) => {
    const sent = stubTelegram();

    const { dispatcher, params } = await startUpdate(STRANGER_USER_ID, text, { claim });

    expect(sent.map((message) => message.text)).toEqual(
      expect.arrayContaining([REQUESTED_TEXT, expect.stringContaining("Access request")]),
    );
    expect(sent.find((message) => message.text.includes("Access request"))?.chat_id).toBe(ADMIN_ID);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(params.values[ADMIN_PARAMETER]).toBe(ADMIN_ID);
  });

  it("handles /start from an enrolled user as an ordinary message", async () => {
    stubTelegram();

    const { dispatcher } = await startUpdate(ALLOWED_USER_ID, "/start");

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("makes a stranger the admin with a live claim code", async () => {
    const sent = stubTelegram();

    const { params, dispatcher } = await startUpdate(STRANGER_USER_ID, `/start ${CLAIM_CODE}`, {
      claim: inFuture(),
    });

    expect(sent.map((message) => message.text)).toEqual([CLAIMED_TEXT]);
    expect(params.values[ADMIN_PARAMETER]).toBe(STRANGER_USER_ID);
    expect(params.values[CLAIM_PARAMETER]).toBeUndefined();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("answers a wrong code against a pending claim without creating a request", async () => {
    const sent = stubTelegram();

    const { params } = await startUpdate(STRANGER_USER_ID, "/start guess-123", {
      claim: inFuture(),
    });

    expect(sent.map((message) => message.text)).toEqual([INVALID_CODE_TEXT]);
    expect(params.values[CLAIM_PARAMETER]).toBeDefined();
  });

  it("connects the registry and bot adapters before first use", async () => {
    stubTelegram();
    const strict = strictStates();

    const { dispatcher } = await startUpdate(ALLOWED_USER_ID, "/start", { strict });

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(strict.prefixes()).toEqual(expect.arrayContaining(["", "bot:garden:"]));
    expect(strict.connects("")).toBe(1);
    expect(strict.connects("bot:garden:")).toBe(1);
  });

  it("lets a stranger's access request use the strict bot adapter", async () => {
    const sent = stubTelegram();

    await startUpdate(STRANGER_USER_ID, "/start", { strict: strictStates() });

    expect(sent.map((message) => message.text)).toContain(REQUESTED_TEXT);
  });

  it("claims the admin through the strict bot adapter", async () => {
    stubTelegram();

    const { params } = await startUpdate(STRANGER_USER_ID, `/start ${CLAIM_CODE}`, {
      claim: inFuture(),
      strict: strictStates(),
    });

    expect(params.values[ADMIN_PARAMETER]).toBe(STRANGER_USER_ID);
  });
});
