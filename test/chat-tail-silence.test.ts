import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatAccess } from "../src/cli/chat-access.js";
import {
  LEAKY_BOT_ID,
  LEAKY_BOT_USERNAME,
  stubTelegramIdentity,
} from "./helpers/chat-tail-fixtures.js";
import { GARDEN_BOT } from "./helpers/receiver-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the chat the CLI builds", () => {
  it("lets nothing from the adapters reach stdout or stderr, including the bot's identity", async () => {
    stubTelegramIdentity();
    const sinks = [
      ...(["debug", "info", "log", "warn", "error"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      ),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];

    const chat = createChatAccess().chatFor(GARDEN_BOT, createMemoryState());
    await chat.initialize();

    const written = sinks.flatMap((sink) => sink.mock.calls.flat()).map(String);
    expect(written).toEqual([]);
    expect(fetch).toHaveBeenCalled();
    for (const identity of [String(LEAKY_BOT_ID), LEAKY_BOT_USERNAME]) {
      expect(written.join("\n")).not.toContain(identity);
    }
  });
});
