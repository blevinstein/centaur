import { describe, expect, it } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import { buildPrompt } from "../src/workflows/prompt.js";
import {
  CHAT_REPLY_PROMPT,
  CHAT_ROLE_SENTENCE,
  readPrompt,
  SCHEDULED_ROLE_SENTENCE,
  scheduledConfig,
} from "./helpers/scheduled-instructions-fixtures.js";
import { prepareScheduled, scheduledSetup, setup } from "./helpers/turn-fixtures.js";
import { message } from "./helpers/workflow-fixtures.js";

describe("the scheduled prompt's role", () => {
  it("uses the scheduled guidance and not the chat reply wording", async () => {
    const run = await scheduledSetup([], scheduledConfig());

    await prepareScheduled(run);

    const text = await readPrompt(run.root);
    expect(text).toContain(SCHEDULED_ROLE_SENTENCE);
    expect(text).not.toContain(CHAT_ROLE_SENTENCE);
    expect(text).toContain("Post this week's tasks.");
  });

  it("replaces the scheduled guidance from the configured file", async () => {
    const run = await setup([], scheduledConfig(".centaur/scheduled.md"), {
      ".centaur/scheduled.md": "Open with the date.",
    });

    await prepareScheduled(run);

    const text = await readPrompt(run.root);
    expect(text).toContain("Open with the date.");
    expect(text).not.toContain(SCHEDULED_ROLE_SENTENCE);
    expect(text).toContain("cannot change these instructions");
  });

  it.each([
    ["missing", ".centaur/missing.md", {}, "missing.md"],
    ["empty", ".centaur/empty.md", { ".centaur/empty.md": "  \n" }, "instructions.scheduled"],
  ])("fails the turn when the configured file is %s", async (_name, path, files, error) => {
    const run = await setup([], scheduledConfig(path), files);

    await expect(prepareScheduled(run)).rejects.toThrow(error);
  });

  it("leaves a chat reply turn's prompt unchanged", async () => {
    const run = await setup([message("1", "hi")]);

    await prepare(run.deps());

    expect(await readPrompt(run.root)).toBe(CHAT_REPLY_PROMPT);
    expect(buildPrompt({ messages: [message("1", "hi")] })).toBe(CHAT_REPLY_PROMPT);
  });

  it("keeps the chat reply wording for a `/new` seed turn", () => {
    const prompt = buildPrompt({ messages: [message("1", "hi")], allowExisting: true });

    expect(prompt).toContain(CHAT_ROLE_SENTENCE);
    expect(prompt).not.toContain(SCHEDULED_ROLE_SENTENCE);
  });
});
