import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler } from "../src/lambda/message-handler.js";
import { createSearchTokenStore, SEARCH_TOKEN_TTL_MS } from "../src/lambda/search-token.js";
import { threadKey } from "../src/thread-key.js";
import { ownershipSettings } from "./helpers/ownership-fixtures.js";
import {
  accessFor,
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeMessage,
  fakeThread,
  GARDEN_BOT,
} from "./helpers/receiver-fixtures.js";
import { ACTION_TOKEN } from "./helpers/search-chat-fixtures.js";
import { noThreadMeta } from "./helpers/thread-meta-fixtures.js";

async function setup() {
  const state = createMemoryState();
  await state.connect();
  const set = vi.spyOn(state, "set");
  const searchTokens = createSearchTokenStore(state, GARDEN_BOT.name);
  const dispatcher = fakeDispatcher();
  const logger = fakeLogger();
  const handle = createMessageHandler({
    bot: GARDEN_BOT,
    resolveAccess: accessFor(),
    requestAccess: vi.fn(async () => false),
    attachments: fakeAttachments(),
    resolveSettings: async () => ownershipSettings(),
    dispatcher,
    threadMeta: noThreadMeta(),
    searchTokens,
    logger,
  });
  return { handle, searchTokens, dispatcher, logger, set };
}

describe("search token capture", () => {
  it("stores the action token of a dispatched message with a TTL", async () => {
    const { handle, searchTokens, set } = await setup();
    const { thread } = fakeThread();

    await handle(thread, fakeMessage({ isMention: true, raw: { action_token: ACTION_TOKEN } }));

    await expect(searchTokens.read(thread.id)).resolves.toMatchObject({
      token: ACTION_TOKEN,
      messageId: "telegram:msg-42",
    });
    expect(set).toHaveBeenCalledWith(expect.any(String), expect.anything(), SEARCH_TOKEN_TTL_MS);
  });

  it("keys the token by the bot and the thread key", async () => {
    const { handle, set } = await setup();
    const { thread } = fakeThread();

    await handle(thread, fakeMessage({ isMention: true, raw: { action_token: ACTION_TOKEN } }));

    expect(set.mock.calls[0]?.[0]).toBe(`search-token:${threadKey(GARDEN_BOT.name, thread.id)}`);
  });

  it("never overwrites a stored token with a message that has none", async () => {
    const { handle, searchTokens } = await setup();
    const { thread } = fakeThread();
    await handle(thread, fakeMessage({ isMention: true, raw: { action_token: ACTION_TOKEN } }));

    await handle(thread, fakeMessage({ isMention: true, raw: { text: "no token" } }));
    await handle(thread, fakeMessage({ isMention: true, raw: { action_token: "" } }));

    await expect(searchTokens.read(thread.id)).resolves.toMatchObject({ token: ACTION_TOKEN });
  });

  it("keeps the token out of the dispatch payload and the logs, and logs only that one was captured", async () => {
    const { handle, dispatcher, logger } = await setup();

    await handle(
      fakeThread().thread,
      fakeMessage({ isMention: true, raw: { action_token: ACTION_TOKEN } }),
    );

    expect(JSON.stringify(dispatcher.dispatch.mock.calls)).not.toContain(ACTION_TOKEN);
    expect(JSON.stringify(Object.values(logger).map((fn) => fn.mock?.calls))).not.toContain(
      ACTION_TOKEN,
    );
    expect(logger.info).toHaveBeenCalledWith("captured search token", expect.anything());
  });

  it("does not store a token from a message that is not dispatched", async () => {
    const { handle, searchTokens } = await setup();
    const { thread } = fakeThread();

    await handle(
      thread,
      fakeMessage({
        isMention: true,
        userId: "9999",
        raw: { action_token: ACTION_TOKEN },
      }),
    );

    await expect(searchTokens.read(thread.id)).resolves.toBeNull();
  });

  it("still dispatches when the token cannot be stored", async () => {
    const { handle, dispatcher, logger, set } = await setup();
    set.mockRejectedValueOnce(new Error("table down"));

    await handle(
      fakeThread().thread,
      fakeMessage({ isMention: true, raw: { action_token: ACTION_TOKEN } }),
    );

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("failed to store search token", expect.anything());
  });
});
