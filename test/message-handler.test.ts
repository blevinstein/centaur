import { describe, expect, it } from "vitest";
import type { RespondTo } from "../src/config/index.js";
import { createMessageHandler, REFUSAL_TEXT } from "../src/lambda/message-handler.js";
import {
  accessFor,
  fakeDispatcher,
  fakeLogger,
  fakeMessage,
  fakeThread,
  GARDEN_BOT,
  MESSAGE_TEXT,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";

function setup(access = accessFor(), respondTo: RespondTo = "mention") {
  const dispatcher = fakeDispatcher();
  const logger = fakeLogger();
  const handle = createMessageHandler({
    bot: GARDEN_BOT,
    resolveAccess: access,
    resolveRespondTo: async () => respondTo,
    dispatcher,
    logger,
  });
  return { handle, dispatcher, logger, access };
}

describe("message handler", () => {
  it("reacts then dispatches IDs only for an allowed sender mentioning the bot", async () => {
    const { handle, dispatcher } = setup();
    const { thread, addReaction } = fakeThread();
    const message = fakeMessage({ isMention: true });

    await handle(thread, message);

    expect(addReaction).toHaveBeenCalledWith(thread.id, message.id, expect.anything());
    expect(dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith("octo/garden", "centaur-message", {
      bot: "garden",
      thread_id: thread.id,
      message_id: message.id,
    });
    expect(JSON.stringify(dispatcher.dispatch.mock.calls)).not.toContain(MESSAGE_TEXT);
    expect(addReaction.mock.invocationCallOrder[0]).toBeLessThan(
      dispatcher.dispatch.mock.invocationCallOrder[0] as number,
    );
  });

  it.each([
    ["a topic the bot created", { state: { createdByBot: true } }, {}],
    ["a direct message", { isDM: true, chatId: "1001" }, {}],
  ])("accepts messages in %s without a mention", async (_name, threadOptions, messageOptions) => {
    const { handle, dispatcher } = setup();

    await handle(fakeThread(threadOptions).thread, fakeMessage(messageOptions));

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it.each(["-100500", "-100900"])(
    "accepts a mention from chat %s when several chats are allowed",
    async (chatId) => {
      const { handle, dispatcher } = setup(accessFor({ chatIds: new Set(["-100500", "-100900"]) }));

      await handle(fakeThread({ chatId }).thread, fakeMessage({ isMention: true }));

      expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    },
  );

  it("ignores group messages that are neither mentions nor in bot-created topics", async () => {
    const { handle, dispatcher, access } = setup();
    const { thread, post, addReaction } = fakeThread({ state: { createdByBot: false } });

    await handle(thread, fakeMessage({ userId: STRANGER_USER_ID }));

    expect(access).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(addReaction).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("refuses unknown senders and logs their ID but never the message text", async () => {
    const { handle, dispatcher, logger } = setup();
    const { thread, post, addReaction } = fakeThread();

    await handle(thread, fakeMessage({ userId: STRANGER_USER_ID, isMention: true }));

    expect(post).toHaveBeenCalledExactlyOnceWith(REFUSAL_TEXT);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown sender"),
      expect.objectContaining({ userId: STRANGER_USER_ID }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(MESSAGE_TEXT);
    expect(addReaction).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("silently ignores mentions from chats that are not allowed, logging the chat ID", async () => {
    const { handle, dispatcher, logger } = setup();
    const { thread, post } = fakeThread({ chatId: "-100777" });

    await handle(thread, fakeMessage({ isMention: true }));

    expect(post).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown chat"),
      expect.objectContaining({ chatId: "-100777" }),
    );
  });

  it("still dispatches when the reaction fails", async () => {
    const { handle, dispatcher, logger } = setup();
    const { thread, addReaction } = fakeThread();
    addReaction.mockRejectedValueOnce(new Error("no rights"));

    await handle(thread, fakeMessage({ isMention: true }));

    expect(logger.error).toHaveBeenCalled();
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  describe("respond_to: all", () => {
    const setupAll = () => setup(accessFor(), "all");

    it.each([
      ["an unaddressed message in the group", {}, {}],
      ["a message in a topic the bot did not create", { state: { createdByBot: false } }, {}],
      ["a message with an unknown bot flag from an allowed sender", {}, { isBot: "unknown" }],
    ] as const)("dispatches %s", async (_name, threadOptions, messageOptions) => {
      const { handle, dispatcher } = setupAll();

      await handle(fakeThread(threadOptions).thread, fakeMessage(messageOptions));

      expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    });

    it.each([
      ["another bot", { isBot: true }],
      ["the bot itself", { isMe: true }],
      ["another bot that mentions this one", { isBot: true, isMention: true }],
    ])("never dispatches a message from %s", async (_name, messageOptions) => {
      const { handle, dispatcher, access } = setupAll();
      const { thread, post, addReaction } = fakeThread();

      await handle(thread, fakeMessage(messageOptions));

      expect(access).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(addReaction).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("silently ignores unaddressed messages from other chats", async () => {
      const { handle, dispatcher, logger } = setupAll();
      const { thread, post } = fakeThread({ chatId: "-100777" });

      await handle(thread, fakeMessage());

      expect(post).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("logs the ID of an unenrolled sender of an unaddressed message without refusing", async () => {
      const { handle, dispatcher, logger } = setupAll();
      const { thread, post } = fakeThread();

      await handle(thread, fakeMessage({ userId: STRANGER_USER_ID }));

      expect(post).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("unknown sender"),
        expect.objectContaining({ userId: STRANGER_USER_ID }),
      );
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("still refuses an unenrolled sender who mentions the bot or direct-messages it", async () => {
      const { handle, dispatcher } = setupAll();
      const mention = fakeThread();
      const dm = fakeThread({ isDM: true, chatId: "1001" });

      await handle(mention.thread, fakeMessage({ userId: STRANGER_USER_ID, isMention: true }));
      await handle(dm.thread, fakeMessage({ userId: STRANGER_USER_ID }));

      expect(mention.post).toHaveBeenCalledExactlyOnceWith(REFUSAL_TEXT);
      expect(dm.post).toHaveBeenCalledExactlyOnceWith(REFUSAL_TEXT);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });
});
