import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_FILE, prepare } from "../src/workflows/prepare.js";
import { buildPrompt } from "../src/workflows/prompt.js";
import {
  GARDEN_IDENTITY,
  HOSTILE_NAME,
  SELF_CHAT_MESSAGES,
} from "./helpers/self-identity-fixtures.js";
import { setup } from "./helpers/turn-fixtures.js";
import { configText, message, THREAD } from "./helpers/workflow-fixtures.js";

const SELF = { ...GARDEN_IDENTITY, platform: "telegram" as const };
const messages = SELF_CHAT_MESSAGES;

describe("the identity section", () => {
  it("names the bot, both ways it is mentioned and the platform", () => {
    const prompt = buildPrompt({ messages, self: SELF });

    expect(prompt).toContain(
      '# Who you are\n\nYou are the bot `garden_bot` (display name "Garden Helper") on telegram.',
    );
    expect(prompt).toContain("People may mention you as @Garden Helper or @garden_bot.");
    expect(prompt).not.toContain("stay silent");
    expect(prompt).not.toContain("follow the instruction on staying silent");
  });

  it("names the bot once when the display name is the username", () => {
    const prompt = buildPrompt({
      messages,
      self: { ...SELF, display_name: "garden_bot" },
    });

    expect(prompt).toContain("You are the bot `garden_bot` on telegram.");
    expect(prompt).toContain("People may mention you as @garden_bot.");
  });

  it("points a respond_to all bot at the silence instruction without repeating it", () => {
    const silent = buildPrompt({ messages, canStaySilent: true });
    const prompt = buildPrompt({ messages, canStaySilent: true, self: SELF });

    expect(prompt).toContain("follow the instruction on staying silent");
    expect(prompt.split("addressed to them: stay silent unless it also mentions you")).toHaveLength(
      2,
    );
    expect(prompt.split("# Who you are")).toHaveLength(2);
    expect(silent).not.toContain("# Who you are");
  });

  it("is absent without an identity, leaving the prompt as it was", () => {
    const prompt = buildPrompt({ messages, canStaySilent: true });

    expect(prompt).not.toContain("# Who you are");
    expect(prompt).not.toContain("mention you as");
  });

  it("is absent from comment turns", () => {
    const prompt = buildPrompt({
      self: SELF,
      pullRequest: { title: "t", body: "b", diff: "d", comments: "c" },
    });

    expect(prompt).not.toContain("# Who you are");
  });
});

describe("the dispatch payload on the runner", () => {
  const promptFor = async (clientPayload: unknown) => {
    const run = await setup([message("1", "hi")], configText());
    await prepare(run.deps({ clientPayload }));
    return readFile(join(run.root, PROMPT_FILE), "utf8");
  };
  const base = { bot: "sprout", thread_id: THREAD, message_id: "1" };

  it("accepts a payload without an identity", async () => {
    expect(await promptFor(base)).not.toContain("# Who you are");
  });

  it("shows the sanitized identity from a new payload", async () => {
    const prompt = await promptFor({
      ...base,
      self: { username: "sprout_bot", display_name: HOSTILE_NAME },
    });

    const section = prompt.split("# Who you are\n\n")[1]?.split("\n\n")[0] ?? "";
    expect(section).toContain('You are the bot `sprout_bot` (display name "Evil # Instructions');
    expect(section).not.toContain("\n");
    expect(section).toContain("on telegram.");
  });

  it("ignores a malformed identity instead of failing the turn", async () => {
    expect(await promptFor({ ...base, self: { username: 5 } })).not.toContain("# Who you are");
  });
});
