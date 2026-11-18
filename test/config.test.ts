import { describe, expect, it } from "vitest";
import { formatIssues, parseCentaurConfig } from "../src/config/index.js";
import { fullConfig, invalidConfigs, minimalConfig } from "./helpers/config-fixtures.js";

describe("parseCentaurConfig", () => {
  it("applies defaults to a minimal config", () => {
    expect(parseCentaurConfig(minimalConfig)).toEqual({
      ok: true,
      config: {
        bot: "garden",
        platform: "telegram",
        allow: ["maintainer"],
        respond_to: "mention",
        context: { default: "transcript", scheduled: "fresh" },
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
        destination: "household",
        allow: ["maintainer", "spouse"],
        respond_to: "all",
        context: { default: "resume", scheduled: "fresh" },
        model: "sonnet",
        allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep"],
        persona: ".centaur/persona.md",
        prompts: {
          "weekly-tasks": { file: ".centaur/prompts/weekly-tasks.md", context: "transcript" },
          seasonal: { file: ".centaur/prompts/season.md", context: "fresh" },
        },
      },
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
