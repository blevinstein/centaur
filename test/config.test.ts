import { describe, expect, it } from "vitest";
import {
  declaredPlatforms,
  formatIssues,
  parseCentaurConfig,
  platformSettings,
  threadPlatform,
} from "../src/config/index.js";
import {
  DEFAULT_CHAT_TOOLS,
  DIRECT_EXECUTION,
  fullConfig,
  invalidConfigs,
  invalidExecutionExtras,
  localServerYaml,
  minimalConfig,
  remoteServerYaml,
  withExtra,
  withMcp,
  withPlatforms,
  yamlOf,
} from "./helpers/config-fixtures.js";

describe("parseCentaurConfig", () => {
  it("applies defaults to a minimal config", () => {
    expect(parseCentaurConfig(minimalConfig)).toEqual({
      ok: true,
      config: {
        bot: "garden",
        platforms: { telegram: { respond_to: "mention", bot_messages: "ignore" } },
        max_turns: 30,
        context: { default: "transcript", scheduled: "fresh", transcript_max_chars: 100000 },
        provider: "anthropic",
        model: "sonnet",
        allowed_tools: ["Read", "Edit"],
        persona: ".centaur/persona.md",
        instructions: {},
        pull_requests: {
          comment_new: true,
          existing: "bot",
          comment_authors: ["OWNER", "MEMBER", "COLLABORATOR"],
        },
        execution: { mode: "pull_request" },
        chat_tools: DEFAULT_CHAT_TOOLS,
        repository_instructions: { enabled: true, max_bytes: 32768, include_repo_root: false },
        skills: { builtin: true, consumer: true },
        mcp_servers: {},
        prompts: {},
      },
    });
  });

  it("parses the skills block over its defaults", () => {
    expect(parseCentaurConfig(withExtra("skills: {consumer: false}"))).toMatchObject({
      ok: true,
      config: { skills: { builtin: true, consumer: false } },
    });
    expect(parseCentaurConfig(withExtra("skills: {builtin: false}"))).toMatchObject({
      ok: true,
      config: { skills: { builtin: false, consumer: true } },
    });
  });

  it("parses the repository_instructions block over its defaults", () => {
    expect(
      parseCentaurConfig(withExtra("repository_instructions: {max_bytes: 100}")),
    ).toMatchObject({
      ok: true,
      config: {
        repository_instructions: { enabled: true, max_bytes: 100, include_repo_root: false },
      },
    });
    expect(
      parseCentaurConfig(withExtra("repository_instructions: {include_repo_root: true}")),
    ).toMatchObject({
      ok: true,
      config: {
        repository_instructions: { enabled: true, max_bytes: 32768, include_repo_root: true },
      },
    });
  });

  it("parses the chat_tools block over its defaults", () => {
    expect(parseCentaurConfig(withExtra("chat_tools: {scope: chat}"))).toMatchObject({
      ok: true,
      config: { chat_tools: { ...DEFAULT_CHAT_TOOLS, scope: "chat" } },
    });
    expect(
      parseCentaurConfig(withExtra("chat_tools: {max_threads: 50, max_messages: 1}")),
    ).toMatchObject({
      ok: true,
      config: { chat_tools: { scope: "thread", max_threads: 50, max_messages: 1 } },
    });
  });

  it("parses the slack_search opt-in", () => {
    expect(
      parseCentaurConfig(withExtra("chat_tools: {scope: chat, slack_search: true}")),
    ).toMatchObject({
      ok: true,
      config: { chat_tools: { ...DEFAULT_CHAT_TOOLS, scope: "chat", slack_search: true } },
    });
  });

  it("parses a full config, normalizing tools and prompts", () => {
    expect(parseCentaurConfig(fullConfig)).toEqual({
      ok: true,
      config: {
        bot: "garden",
        platforms: {
          telegram: { respond_to: "all", bot_messages: "mention" },
          slack: { respond_to: "mention", bot_messages: "ignore" },
        },
        effort: "low",
        max_turns: 12,
        max_budget_usd: 0.5,
        context: { default: "resume", scheduled: "fresh", transcript_max_chars: 100000 },
        provider: "anthropic",
        model: "sonnet",
        allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep"],
        persona: ".centaur/persona.md",
        instructions: {
          chat: ".centaur/chat.md",
          chat_tools: ".centaur/chat-tools.md",
          comment: ".centaur/comment.md",
          scheduled: ".centaur/scheduled.md",
          silence: ".centaur/silence.md",
        },
        pull_requests: {
          comment_new: true,
          existing: "bot",
          comment_authors: ["OWNER", "MEMBER", "COLLABORATOR"],
        },
        execution: { mode: "pull_request" },
        chat_tools: DEFAULT_CHAT_TOOLS,
        repository_instructions: { enabled: true, max_bytes: 32768, include_repo_root: false },
        skills: { builtin: true, consumer: true },
        mcp_servers: {},
        prompts: {
          "weekly-tasks": {
            file: ".centaur/prompts/weekly-tasks.md",
            model: "sonnet",
            effort: "low",
            context: "transcript",
            thread: "new",
            targets: [
              { platform: "telegram", destination: "household" },
              { platform: "slack", destination: "household" },
            ],
          },
          seasonal: {
            file: ".centaur/prompts/season.md",
            model: "sonnet",
            effort: "low",
            context: "fresh",
            thread: "new",
            targets: [
              { platform: "telegram", destination: "workshop" },
              { platform: "slack", destination: "workshop-alerts" },
            ],
          },
        },
      },
    });
  });

  it("accepts a transcript_max_chars override", () => {
    expect(parseCentaurConfig(withExtra("context: {transcript_max_chars: 5000}"))).toMatchObject({
      ok: true,
      config: { context: { default: "transcript", transcript_max_chars: 5000 } },
    });
  });

  it("parses and validates the pull_requests block", () => {
    expect(parseCentaurConfig(withExtra("pull_requests: {existing: off}"))).toMatchObject({
      ok: true,
      config: { pull_requests: { comment_new: true, existing: "off" } },
    });
    expect(parseCentaurConfig(withExtra("pull_requests: {comment_new: false}"))).toMatchObject({
      ok: true,
      config: { pull_requests: { comment_new: false, existing: "bot" } },
    });
    expect(
      parseCentaurConfig(withExtra("pull_requests: {comment_authors: [OWNER, CONTRIBUTOR]}")),
    ).toMatchObject({
      ok: true,
      config: { pull_requests: { comment_authors: ["OWNER", "CONTRIBUTOR"] } },
    });
    for (const extra of [
      "pull_requests: {comment_authors: []}",
      "pull_requests: {comment_authors: [ADMIN]}",
      "pull_requests: {comment_authors: OWNER}",
      "pull_requests: {existing: thread}",
      "pull_requests: {comment_new: yes please}",
      "pull_requests: {other: 1}",
    ]) {
      expect(parseCentaurConfig(withExtra(extra)).ok).toBe(false);
    }
  });

  it("parses and validates the execution block", () => {
    expect(parseCentaurConfig(withExtra(DIRECT_EXECUTION))).toMatchObject({
      ok: true,
      config: { execution: { mode: "direct" } },
    });
    expect(parseCentaurConfig(withExtra("execution: {mode: pull_request}"))).toMatchObject({
      ok: true,
      config: { execution: { mode: "pull_request" }, pull_requests: { existing: "bot" } },
    });
    for (const extra of invalidExecutionExtras) {
      expect(parseCentaurConfig(withExtra(extra)).ok).toBe(false);
    }
  });

  it("accepts respond_to all and prompts without any chat list", () => {
    expect(
      parseCentaurConfig(
        withPlatforms("{slack: {respond_to: all}}", "prompts: {weekly: {destination: household}}"),
      ),
    ).toMatchObject({
      ok: true,
      config: {
        platforms: { slack: { respond_to: "all", bot_messages: "ignore" } },
        prompts: { weekly: { targets: [{ platform: "slack", destination: "household" }] } },
      },
    });
  });

  it.each(["@preset/foo", "~anthropic/claude-sonnet-latest[1m]", "claude-opus-4-1"])(
    "accepts the model %s",
    (model) => {
      expect(parseCentaurConfig(yamlOf({ model: JSON.stringify(model) }))).toMatchObject({
        ok: true,
        config: { model },
      });
    },
  );

  it.each([
    ["by default", "prompts: {weekly: {destination: household}}", "new"],
    ["when new", "prompts: {weekly: {destination: household, thread: new}}", "new"],
    [
      "when persistent",
      "prompts: {weekly: {destination: household, thread: persistent}}",
      "persistent",
    ],
  ])("sets the thread mode %s", (_name, prompts, mode) => {
    expect(parseCentaurConfig(withExtra(prompts))).toMatchObject({
      ok: true,
      config: { prompts: { weekly: { thread: mode } } },
    });
  });

  it("resolves a prompt's model and effort over the bot-wide ones", () => {
    expect(
      parseCentaurConfig(
        withExtra("prompts: {weekly: {destination: household, model: haiku, effort: max}}"),
      ),
    ).toMatchObject({
      ok: true,
      config: { model: "sonnet", prompts: { weekly: { model: "haiku", effort: "max" } } },
    });
  });

  it("applies a string destination to the only declared platform", () => {
    expect(
      parseCentaurConfig(
        withPlatforms("{telegram: {}}", "prompts: {weekly: {destination: household}}"),
      ),
    ).toMatchObject({
      ok: true,
      config: {
        prompts: { weekly: { targets: [{ platform: "telegram", destination: "household" }] } },
      },
    });
  });

  it("accepts a one-entry destination map on a multi-platform bot", () => {
    expect(
      parseCentaurConfig(
        withPlatforms(
          "{telegram: {}, slack: {}}",
          "prompts: {weekly: {destination: {slack: household}}}",
        ),
      ),
    ).toMatchObject({
      ok: true,
      config: {
        prompts: { weekly: { targets: [{ platform: "slack", destination: "household" }] } },
      },
    });
  });

  it("accepts a per-platform destination map for a subset of the declared platforms", () => {
    expect(
      parseCentaurConfig(
        withPlatforms(
          "{telegram: {}, slack: {}}",
          "prompts: {weekly: {context: resume, destination: {telegram: household}}}",
        ),
      ),
    ).toMatchObject({
      ok: true,
      config: {
        prompts: {
          weekly: { targets: [{ platform: "telegram", destination: "household" }] },
        },
      },
    });
  });

  it("resolves platform settings and thread platforms", () => {
    const result = parseCentaurConfig(fullConfig);
    if (!result.ok) throw new Error(formatIssues(result.issues));
    expect(platformSettings(result.config, "telegram")).toEqual({
      respond_to: "all",
      bot_messages: "mention",
    });
    expect(declaredPlatforms(result.config)).toEqual(["telegram", "slack"]);
    expect(threadPlatform("slack:C1:1.2")).toBe("slack");
    expect(() => threadPlatform("irc:1")).toThrow(/no known platform/);
    expect(() => platformSettings({ platforms: {} }, "slack")).toThrow(/does not declare/);
  });

  it("accepts instruction overrides as repo-relative paths only", () => {
    expect(
      parseCentaurConfig(
        withExtra("instructions: {chat: .centaur/chat.md, scheduled: .centaur/scheduled.md}"),
      ),
    ).toMatchObject({
      ok: true,
      config: { instructions: { chat: ".centaur/chat.md", scheduled: ".centaur/scheduled.md" } },
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
    const result = parseCentaurConfig("bot: A\nplatforms: {irc: {}}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatIssues(result.issues)).toMatch(/^bot: .*\nplatforms/);
    }
  });
});
