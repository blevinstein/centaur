import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const manifest = parse(readFileSync("docs/slack-app-manifest.yml", "utf8"));

describe("the Slack app manifest", () => {
  it("lets users DM the bot, which admin claims and access requests need", () => {
    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });
});
