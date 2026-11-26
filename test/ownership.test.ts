import { describe, expect, it } from "vitest";
import { ownsMessage } from "../src/lambda/ownership.js";
import {
  ADDRESSING_SCENARIOS,
  AUTHOR_CASES,
  BOT_MESSAGES_MODES,
  ownershipSettings,
  RESPOND_TO_MODES,
} from "./helpers/ownership-fixtures.js";
import { fakeMessage, fakeThread } from "./helpers/receiver-fixtures.js";
import { memoryThreadMeta, noThreadMeta } from "./helpers/thread-meta-fixtures.js";

describe("ownsMessage", () => {
  describe.each(RESPOND_TO_MODES)("with respond_to %s", (respondTo) => {
    describe.each(BOT_MESSAGES_MODES)("and bot_messages %s", (botMessages) => {
      const settings = ownershipSettings(respondTo, botMessages);

      describe.each(Object.entries(ADDRESSING_SCENARIOS))("in a %s", (_, scenario) => {
        it.each(AUTHOR_CASES)("message from %s", async (_who, author, owned) => {
          const { thread } = fakeThread(scenario.thread);
          const message = fakeMessage({ isMention: scenario.mention, ...author });
          await expect(ownsMessage(thread, message, settings, noThreadMeta())).resolves.toBe(
            owned(botMessages, scenario.mention),
          );
        });
      });

      it.each(AUTHOR_CASES)(
        "message from %s in a thread-meta thread",
        async (_who, author, owned) => {
          const threadMeta = await memoryThreadMeta();
          const { thread } = fakeThread();
          await threadMeta.write(thread.id, { setBy: "start-thread", context: "resume" });
          await expect(
            ownsMessage(thread, fakeMessage(author), settings, threadMeta),
          ).resolves.toBe(owned(botMessages, false));
        },
      );
    });
  });

  describe.each(BOT_MESSAGES_MODES)("unaddressed message with bot_messages %s", (botMessages) => {
    it.each(AUTHOR_CASES)("from %s in all mode", async (_who, author, owned) => {
      const { thread } = fakeThread();
      await expect(
        ownsMessage(
          thread,
          fakeMessage(author),
          ownershipSettings("all", botMessages),
          noThreadMeta(),
        ),
      ).resolves.toBe(owned(botMessages, false));
    });
  });

  it("does not treat an unknown author kind as a bot", async () => {
    const { thread } = fakeThread({ isDM: true });
    await expect(
      ownsMessage(thread, fakeMessage({ isBot: "unknown" }), ownershipSettings(), noThreadMeta()),
    ).resolves.toBe(true);
  });
});
