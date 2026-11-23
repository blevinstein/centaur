import { describe, expect, it } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import { readTurnState } from "../src/workflows/turn-state.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  budgetConfig,
  budgetSetup,
  letters,
  readPrompt,
  sizedMessages,
} from "./helpers/turn-fixtures.js";

describe("transcript budget", () => {
  it("fills newest first and omits the oldest messages that do not fit", async () => {
    const { deps, root } = await budgetSetup([30, 30, 30, 30], budgetConfig(100));

    await prepare(deps());

    const text = await readPrompt(root);
    expect(text).toContain(letters(1, 30));
    expect(text).toContain(letters(3, 30));
    expect(text).not.toContain(letters(0, 30));
    expect(text).toContain("1 earlier message in this thread is omitted");
    expect(text.indexOf(letters(1, 30))).toBeLessThan(text.indexOf(letters(3, 30)));
  });

  it("shows a message that ends exactly at the budget and omits one past it", async () => {
    const exact = await budgetSetup([30, 30, 30, 30], budgetConfig(90));
    await prepare(exact.deps());
    const past = await budgetSetup([30, 30, 30, 30], budgetConfig(89));
    await prepare(past.deps());

    expect(await readPrompt(exact.root)).toContain("1 earlier message in this thread is omitted");
    expect(await readPrompt(exact.root)).toContain(letters(1, 30));
    expect(await readPrompt(past.root)).toContain("2 earlier messages in this thread are omitted");
    expect(await readPrompt(past.root)).not.toContain(letters(1, 30));
  });

  it("shows no note when everything fits", async () => {
    const { deps, root } = await budgetSetup([10, 10], budgetConfig(100));

    await prepare(deps());

    expect(await readPrompt(root)).not.toContain("omitted");
  });

  it("cuts one message longer than half the budget and says so", async () => {
    const { deps, root } = await budgetSetup([10, 80, 10], budgetConfig(100));

    await prepare(deps());

    const text = await readPrompt(root);
    expect(text).toContain(letters(1, 50));
    expect(text).not.toContain(letters(1, 51));
    expect(text).toContain("[message shortened: first 50 of 80 characters shown]");
    expect(text).not.toContain("omitted");
  });

  it("shows pending messages in full and leaves the marker and sources alone", async () => {
    const pending = "p".repeat(500);
    const { deps, root, stateDir } = await budgetSetup([50, 50, 50], budgetConfig(100), pending);

    await prepare(deps());

    const text = await readPrompt(root);
    expect(text).toContain(pending);
    expect(text).not.toContain("shortened");
    expect(text).toContain("1 earlier message in this thread is omitted");
    const state = await readTurnState(stateDir);
    expect(state.marker).toBe("4");
    expect(state.source?.messageIds).toEqual(["4"]);
  });

  it("points at read_thread only when the chat tools are enabled", async () => {
    const withTools = await budgetSetup([30, 30, 30], budgetConfig(50, true));
    await prepare(withTools.deps());
    const withoutTools = await budgetSetup([30, 30, 30], budgetConfig(50));
    await prepare(withoutTools.deps());

    expect(await readPrompt(withTools.root)).toContain(
      "call `read_thread` on `thread-0` with a `before` cursor",
    );
    const text = await readPrompt(withoutTools.root);
    expect(text).toContain("They are not available this turn");
    expect(text).not.toContain("call `read_thread` on `thread-0`");
  });

  it("bounds the transcript of a pull request comment turn", async () => {
    const { deps, root } = await commentSetup({
      comments: [prComment(1, "tweak")],
      messages: sizedMessages([30, 30, 30, 30]),
      config: budgetConfig(90, true),
    });

    await prepare(deps());

    const text = await readPrompt(root);
    expect(text).toContain(letters(3, 30));
    expect(text).not.toContain(letters(0, 30));
    expect(text).toContain("1 earlier message in this thread is omitted");
    expect(text).toContain("call `read_thread` on `thread-0`");
  });
});
