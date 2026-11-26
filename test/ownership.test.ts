import { describe, expect, it } from "vitest";
import { ownsMessage } from "../src/lambda/ownership.js";
import { ADDRESSING_SCENARIOS, AUTHOR_CASES } from "./helpers/ownership-fixtures.js";
import { fakeMessage, fakeThread } from "./helpers/receiver-fixtures.js";
import { memoryThreadMeta, noThreadMeta } from "./helpers/thread-meta-fixtures.js";

describe("ownsMessage", () => {
  describe.each(Object.entries(ADDRESSING_SCENARIOS))("in a %s", (_, scenario) => {
    it.each(AUTHOR_CASES)("message from %s: owned=%s", async (_who, author, owned) => {
      const { thread } = fakeThread(scenario.thread);
      const message = fakeMessage({ isMention: scenario.mention, ...author });
      await expect(ownsMessage(thread, message, "mention", noThreadMeta())).resolves.toBe(owned);
    });
  });

  describe.each(["mention", "all"] as const)("in %s mode", (respondTo) => {
    it.each(AUTHOR_CASES)(
      "message from %s in a thread-meta thread: owned=%s",
      async (_who, author, owned) => {
        const threadMeta = await memoryThreadMeta();
        const { thread } = fakeThread();
        await threadMeta.write(thread.id, { setBy: "start-thread", context: "resume" });
        await expect(ownsMessage(thread, fakeMessage(author), respondTo, threadMeta)).resolves.toBe(
          owned,
        );
      },
    );
  });

  it.each(AUTHOR_CASES)(
    "unaddressed message from %s in all mode: owned=%s",
    async (_who, author, owned) => {
      const { thread } = fakeThread();
      await expect(ownsMessage(thread, fakeMessage(author), "all", noThreadMeta())).resolves.toBe(
        owned,
      );
    },
  );

  it("does not treat an unknown author kind as a bot", async () => {
    const { thread } = fakeThread({ isDM: true });
    await expect(
      ownsMessage(thread, fakeMessage({ isBot: "unknown" }), "mention", noThreadMeta()),
    ).resolves.toBe(true);
  });
});
