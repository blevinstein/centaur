import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findConfigFile } from "../src/workflows/config-file.js";
import { loadSelfConfig } from "./helpers/self-config.js";

describe("this repo's Centaur config", () => {
  it("lives at .centaur/config.yml", async () => {
    expect(await findConfigFile(".")).toBe(".centaur/config.yml");
  });

  it("declares Slack and Telegram, and points at files that exist", async () => {
    const config = await loadSelfConfig();
    expect(config.platforms).toEqual({
      slack: { respond_to: "all" },
      telegram: { respond_to: "all" },
    });
    expect(config.prompts.hello?.file).toBe(".centaur/prompts/hello.md");
    for (const file of [config.persona, config.prompts.hello?.file ?? ""]) {
      expect(readFileSync(file, "utf8")).not.toBe("");
    }
  });

  it("enables the chat context tools for the live run", async () => {
    expect((await loadSelfConfig()).chat_tools.scope).toBe("chat");
  });

  it("targets exactly one Slack destination per prompt", async () => {
    const { prompts } = await loadSelfConfig();
    expect(Object.keys(prompts).sort()).toEqual(["hello", "mcp-smoke", "pr-smoke", "pr-update"]);
    for (const prompt of Object.values(prompts)) {
      expect(prompt.targets).toEqual([{ platform: "slack", destination: "centaur-test-slack" }]);
    }
  });
});
