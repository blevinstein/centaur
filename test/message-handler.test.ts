import { describe, expect, it, vi } from "vitest";
import type { BotMessages, RespondTo } from "../src/config/index.js";
import type { AccessRequester } from "../src/lambda/access-requests.js";
import type { AdminClaimer } from "../src/lambda/admin-claims.js";
import {
  ATTACHMENT_FAILURE_TEXT,
  createMessageHandler,
  REFUSAL_TEXT,
} from "../src/lambda/message-handler.js";
import type { ThreadMetaStore } from "../src/lambda/thread-meta.js";
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
  GROUP_CHAT_ID,
  MESSAGE_TEXT,
  noSearchTokens,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";
import { memoryThreadMeta, noThreadMeta } from "./helpers/thread-meta-fixtures.js";

function setup(
  access = accessFor(),
  respondTo: RespondTo | null = "mention",
  threadMeta: Pick<ThreadMetaStore, "read"> = noThreadMeta(),
  botMessages: BotMessages = "ignore",
) {
  const claimAdmin = vi.fn<AdminClaimer>(async () => "claimed");
  const dispatcher = fakeDispatcher();
  const logger = fakeLogger();
  const attachments = fakeAttachments();
  const searchTokens = noSearchTokens();
  const requestAccess = vi.fn<AccessRequester>(async () => false);
  const handle = createMessageHandler({
    bot: GARDEN_BOT,
    resolveAccess: access,
    requestAccess,
    attachments,
    claimAdmin,
    resolveSettings: async () =>
      respondTo ? ownershipSettings(respondTo, botMessages) : undefined,
    dispatcher,
    threadMeta,
    searchTokens,
    logger,
  });
  return {
    handle,
    dispatcher,
    logger,
    access,
    requestAccess,
    claimAdmin,
    attachments,
    searchTokens,
  };
}

describe("message handler", () => {
  it("ignores a message on a connection the registry does not list", async () => {
    const { handle, dispatcher } = setup(accessFor(), null);
    const { thread, addReaction } = fakeThread();

    await handle(thread, fakeMessage({ isMention: true }));

    expect(addReaction).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
  it("accepts an unaddressed reply in a thread whose thread-meta record exists after the thread state expired", async () => {
    const threadMeta = await memoryThreadMeta();
    const { thread } = fakeThread();
    await threadMeta.write(thread.id, { setBy: "start-thread", context: "resume" });
    const { handle, dispatcher } = setup(accessFor(), "mention", threadMeta);

    await handle(thread, fakeMessage({ isMention: false }));

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("ignores an unaddressed message in a thread with no thread-meta record or state", async () => {
    const { handle, dispatcher } = setup();
    const { thread } = fakeThread();

    await handle(thread, fakeMessage({ isMention: false }));

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("reacts then dispatches IDs only for an allowed sender mentioning the bot", async () => {
    const { handle, dispatcher } = setup();
    const { thread, addReaction } = fakeThread();
    const message = fakeMessage({ isMention: true });

    await handle(thread, message);

    expect(addReaction).toHaveBeenCalledWith(thread.id, message.id, expect.anything());
    expect(dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith("octo/garden", "centaur-message", {
      bot: "garden",
      thread_id: thread.id,
      thread_key: threadKey("garden", thread.id),
      message_id: message.id,
    });
    expect(JSON.stringify(dispatcher.dispatch.mock.calls)).not.toContain(MESSAGE_TEXT);
    expect(addReaction.mock.invocationCallOrder[0]).toBeLessThan(
      dispatcher.dispatch.mock.invocationCallOrder[0] as number,
    );
  });

  it("stores attachments before reacting and dispatching", async () => {
    const { handle, dispatcher, attachments } = setup();
    const { thread, addReaction } = fakeThread();
    const message = fakeMessage({ isMention: true, attachments: [{ type: "image" }] });

    await handle(thread, message);

    expect(attachments.save).toHaveBeenCalledExactlyOnceWith("garden", message);
    const [saved] = attachments.save.mock.invocationCallOrder;
    expect(saved).toBeLessThan(addReaction.mock.invocationCallOrder[0] as number);
    expect(saved).toBeLessThan(dispatcher.dispatch.mock.invocationCallOrder[0] as number);
  });

  it("tells the sender and does not dispatch when storing attachments fails", async () => {
    const { handle, dispatcher, attachments, logger } = setup();
    attachments.save.mockRejectedValueOnce(new Error("s3 down"));
    const { thread, post, addReaction } = fakeThread();

    await handle(thread, fakeMessage({ isMention: true, attachments: [{ type: "image" }] }));

    expect(post).toHaveBeenCalledExactlyOnceWith(ATTACHMENT_FAILURE_TEXT);
    expect(addReaction).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it.each([
    ["an unknown sender", { userId: STRANGER_USER_ID }],
    ["an unaddressed group message", { isMention: false }],
  ])("stores no attachments for %s", async (_name, overrides) => {
    const { handle, attachments } = setup();

    await handle(
      fakeThread().thread,
      fakeMessage({ attachments: [{ type: "image" }], ...overrides }),
    );

    expect(attachments.save).not.toHaveBeenCalled();
  });

  it.each([
    ["a topic the bot created", { state: { createdByBot: true } }, {}],
    ["a direct message", { isDM: true, chatId: "1001" }, {}],
  ])("accepts messages in %s without a mention", async (_name, threadOptions, messageOptions) => {
    const { handle, dispatcher } = setup();

    await handle(fakeThread(threadOptions).thread, fakeMessage(messageOptions));

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("never marks a mentioned Telegram thread as followed, since its ID can be the whole chat", async () => {
    const { handle, dispatcher } = setup();
    const { thread, setState } = fakeThread();

    await handle(thread, fakeMessage({ isMention: true }));
    await handle(fakeThread().thread, fakeMessage());

    expect(setState).not.toHaveBeenCalled();
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

  describe("admin claim", () => {
    it("lets a stranger's direct message claim, replies, and does not process it further", async () => {
      const { handle, claimAdmin, dispatcher, access } = setup();
      const { thread, post } = fakeThread({ isDM: true, chatId: "9999" });

      await handle(thread, fakeMessage({ userId: STRANGER_USER_ID, text: "Claim abc-123 " }));

      expect(claimAdmin).toHaveBeenCalledWith({
        userId: STRANGER_USER_ID,
        isDM: true,
        code: "abc-123",
      });
      expect(post).toHaveBeenCalledExactlyOnceWith("claimed");
      expect(access).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("treats the message as ordinary when the claimer ignores it", async () => {
      const { handle, claimAdmin, dispatcher } = setup();
      claimAdmin.mockResolvedValue(undefined);

      await handle(fakeThread({ isDM: true }).thread, fakeMessage({ text: "claim abc" }));

      expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    });

    it.each([
      ["outside a direct message", { chatId: "-100500" }, "claim abc"],
      ["with no code", { isDM: true }, "claim"],
      ["with extra words", { isDM: true }, "claim this for me"],
    ])("does not attempt a claim %s", async (_name, threadOptions, text) => {
      const { handle, claimAdmin } = setup();

      await handle(fakeThread(threadOptions).thread, fakeMessage({ isMention: true, text }));

      expect(claimAdmin).not.toHaveBeenCalled();
    });
  });

  describe("access requests", () => {
    it.each([
      ["chat", { chatId: "-100777" }, {}],
      ["user", {}, { userId: STRANGER_USER_ID }],
    ] as const)(
      "asks for a %s request instead of refusing an addressed message",
      async (kind, threadOptions, messageOptions) => {
        const { handle, dispatcher, requestAccess } = setup();
        requestAccess.mockResolvedValue(true);
        const { thread, post } = fakeThread(threadOptions);
        const message = fakeMessage({ isMention: true, ...messageOptions });

        await handle(thread, message);

        expect(requestAccess).toHaveBeenCalledExactlyOnceWith(kind, thread, message);
        expect(post).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
      },
    );

    it("never requests access for unaddressed messages", async () => {
      const { handle, requestAccess } = setup(accessFor(), "all");

      await handle(fakeThread({ chatId: "-100777" }).thread, fakeMessage());
      await handle(fakeThread().thread, fakeMessage({ userId: STRANGER_USER_ID }));

      expect(requestAccess).not.toHaveBeenCalled();
    });

    it.each([
      ["chat", accessFor({ blockedChatIds: new Set([GROUP_CHAT_ID]) }), {}],
      [
        "user",
        accessFor({ blockedUserIds: new Set([STRANGER_USER_ID]) }),
        { userId: STRANGER_USER_ID },
      ],
    ] as const)(
      "ignores a blocked %s before any reply or request",
      async (_kind, access, messageOptions) => {
        const { handle, dispatcher, requestAccess } = setup(access);
        const { thread, post, addReaction } = fakeThread();

        await handle(thread, fakeMessage({ isMention: true, ...messageOptions }));

        expect(requestAccess).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(addReaction).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
      },
    );

    it("keeps today's behavior when no request is created", async () => {
      const { handle } = setup();
      const unknownUser = fakeThread();
      const unknownChat = fakeThread({ chatId: "-100777" });

      await handle(unknownUser.thread, fakeMessage({ userId: STRANGER_USER_ID, isMention: true }));
      await handle(unknownChat.thread, fakeMessage({ isMention: true }));

      expect(unknownUser.post).toHaveBeenCalledExactlyOnceWith(REFUSAL_TEXT);
      expect(unknownChat.post).not.toHaveBeenCalled();
    });
  });

  describe.each(["mention", "all"] as const)(
    "bot_messages: mention with respond_to %s",
    (respondTo) => {
      const setupBots = () => setup(accessFor(), respondTo, noThreadMeta(), "mention");

      it("dispatches a message from another bot that mentions this one", async () => {
        const { handle, dispatcher } = setupBots();

        await handle(fakeThread().thread, fakeMessage({ isBot: true, isMention: true }));

        expect(dispatcher.dispatch).toHaveBeenCalledOnce();
      });

      it.each([
        ["another bot without a mention", { isBot: true }],
        ["the bot itself that mentions itself", { isMe: true, isBot: true, isMention: true }],
      ])("never dispatches a message from %s", async (_name, messageOptions) => {
        const { handle, dispatcher } = setupBots();

        await handle(fakeThread({ isDM: true }).thread, fakeMessage(messageOptions));

        expect(dispatcher.dispatch).not.toHaveBeenCalled();
      });
    },
  );

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
