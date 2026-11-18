import { describe, expect, it } from "vitest";
import { formatIssues, parseCentaurConfig } from "../src/config/index.js";
import { fullConfig, invalidConfigs, minimalConfig, withExtra } from "./helpers/config-fixtures.js";

describe("parseCentaurConfig", () => {
  it("applies defaults to a minimal config", () => {
    expect(parseCentaurConfig(minimalConfig)).toEqual({
      ok: true,
      config: {
        bot: "garden",
        platform: "telegram",
        respond_to: "mention",
        max_turns: 30,
        context: { default: "transcript", scheduled: "fresh" },
        provider: "anthropic",
        model: "sonnet",
        allowed_tools: ["Read", "Edit"],
        persona: ".centaur/persona.md",
        prompts: {},
      },
    });
  });

  it("parses a full config, normalizing tools and prompts", () => {
    expect(parseCentaurConfig(fullConfig)).toEqual({
      ok: true,
      config: {
        bot: "garden",
        platform: "telegram",
        respond_to: "all",
        handle: "garden_helper_bot",
        effort: "low",
        max_turns: 12,
        max_budget_usd: 0.5,
        context: { default: "resume", scheduled: "fresh" },
        provider: "anthropic",
        model: "sonnet",
        allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep"],
        persona: ".centaur/persona.md",
        prompts: {
          "weekly-tasks": {
            file: ".centaur/prompts/weekly-tasks.md",
            context: "transcript",
            destination: "household",
          },
          seasonal: {
            file: ".centaur/prompts/season.md",
            context: "fresh",
            destination: "workshop",
          },
        },
      },
    });
  });

  it("accepts respond_to all and prompts without any chat list", () => {
    expect(
      parseCentaurConfig(withExtra("respond_to: all\nprompts: {weekly: {destination: household}}")),
    ).toMatchObject({
      ok: true,
      config: { respond_to: "all", prompts: { weekly: { destination: "household" } } },
    });
  });

  it("accepts allowed_tools as a list", () => {
    const result = parseCentaurConfig(minimalConfig.replace("Read,Edit", "[Read, Edit]"));
    expect(result).toMatchObject({ ok: true, config: { allowed_tools: ["Read", "Edit"] } });
  });

  it.each(invalidConfigs)("rejects %s", (_name, text, path, message) => {
    const result = parseCentaurConfig(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ path, message: expect.stringMatching(message) });
    }
  });

  it("formats issues one per line with their paths", () => {
    const result = parseCentaurConfig("bot: A\nplatform: irc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatIssues(result.issues)).toMatch(/^bot: .*\nplatform: /);
    }
  });
});
