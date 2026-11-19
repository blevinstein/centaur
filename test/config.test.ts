import { describe, expect, it } from "vitest";
import { formatIssues, parseCentaurConfig } from "../src/config/index.js";
import {
  fullConfig,
  invalidConfigs,
  localServerYaml,
  minimalConfig,
  remoteServerYaml,
  withExtra,
  withMcp,
} from "./helpers/config-fixtures.js";

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
        instructions: {},
        mcp_servers: {},
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
        instructions: {},
        mcp_servers: {},
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

  it("accepts instruction overrides as repo-relative paths only", () => {
    expect(parseCentaurConfig(withExtra("instructions: {chat: .centaur/chat.md}"))).toMatchObject({
      ok: true,
      config: { instructions: { chat: ".centaur/chat.md" } },
    });
    for (const extra of ["instructions: {chat: ../x.md}", "instructions: {other: a.md}"]) {
      expect(parseCentaurConfig(withExtra(extra)).ok).toBe(false);
    }
  });

  it("accepts allowed_tools as a list", () => {
    const result = parseCentaurConfig(minimalConfig.replace("Read,Edit", "[Read, Edit]"));
    expect(result).toMatchObject({ ok: true, config: { allowed_tools: ["Read", "Edit"] } });
  });

  it("parses remote and local MCP servers with secret references", () => {
    expect(
      parseCentaurConfig(
        withMcp(
          remoteServerYaml + localServerYaml,
          "Read, mcp__linear__*, mcp__docs-search__search",
        ),
      ),
    ).toMatchObject({
      ok: true,
      config: {
        mcp_servers: {
          linear: {
            url: "https://mcp.linear.app/mcp",
            headers: {
              Authorization: { secret: "LINEAR_API_KEY", prefix: "Bearer " },
              "X-Org": "acme",
            },
          },
          "docs-search": {
            command: "npx",
            args: ["-y", "@example/docs-mcp@1.4.2"],
            env: {
              INDEX_URL: "https://docs.example.com/index",
              API_KEY: { secret: "DOCS_API_KEY" },
            },
          },
        },
      },
    });
  });

  it("accepts the bare mcp__<server> form and leaves built-in github tools alone", () => {
    expect(
      parseCentaurConfig(
        withMcp(localServerYaml, "mcp__docs-search, mcp__github_comment__update_claude_comment"),
      ).ok,
    ).toBe(true);
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
