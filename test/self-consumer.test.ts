import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSingleConfigStyle, findConfigFile } from "../src/workflows/config-file.js";
import { loadWorkflow } from "./action-fixtures.js";
import {
  installSelfInstructions,
  loadSelfConfig,
  SELF_ROOT,
  SELF_ROOT_2,
  SELF_ROOT_DEV,
  SELF_ROOTS,
  selfPath,
} from "./helpers/self-config.js";

describe("this repo's Centaur config", () => {
  it("lives at apps/centaur-test/.centaur/config.yml", async () => {
    expect(await findConfigFile(".", SELF_ROOT)).toBe(selfPath(".centaur/config.yml"));
  });

  it("declares Slack and Telegram, and points at files that exist", async () => {
    const config = await loadSelfConfig();
    expect(config.platforms).toEqual({
      slack: { respond_to: "all", bot_messages: "mention" },
      telegram: { respond_to: "all", bot_messages: "ignore" },
    });
    expect(config.prompts.hello?.file).toBe(".centaur/prompts/hello.md");
    for (const file of [config.persona, config.prompts.hello?.file ?? ""]) {
      expect(readFileSync(selfPath(file), "utf8")).not.toBe("");
    }
  });

  it("enables the chat context tools for the live run", async () => {
    expect((await loadSelfConfig()).chat_tools.scope).toBe("chat");
  });

  it("posts hello and mcp-smoke to Slack and Telegram, the PR prompts to Slack only", async () => {
    const { prompts } = await loadSelfConfig();
    expect(Object.keys(prompts).sort()).toEqual([
      "hello",
      "hello-telegram",
      "mcp-smoke",
      "pr-smoke",
      "pr-update",
    ]);
    expect(prompts["hello-telegram"]?.file).toBe(".centaur/prompts/hello.md");
    const slack = { platform: "slack", destination: "centaur-test-slack" };
    const telegram = { platform: "telegram", destination: "centaur-test" };
    for (const name of ["hello", "mcp-smoke"]) {
      expect(prompts[name]?.targets).toEqual([slack, telegram]);
    }
    expect(prompts["hello-telegram"]?.targets).toEqual([telegram]);
    for (const name of ["pr-smoke", "pr-update"]) {
      expect(prompts[name]?.targets).toEqual([slack]);
    }
  });

  it("keeps one persistent thread for hello-telegram and a new thread for the other prompts", async () => {
    const { prompts } = await loadSelfConfig();
    expect(prompts["hello-telegram"]?.thread).toBe("persistent");
    expect(Object.values(prompts).filter((prompt) => prompt.thread === "new")).toHaveLength(
      Object.keys(prompts).length - 1,
    );
  });

  describe("the second bot", () => {
    it("lives at apps/centaur-test-2/.centaur/config.yml, so the one-style rule holds", async () => {
      expect(await findConfigFile(".", SELF_ROOT_2)).toBe(
        selfPath(".centaur/config.yml", SELF_ROOT_2),
      );
      await expect(assertSingleConfigStyle(".", SELF_ROOT_2)).resolves.toBeUndefined();
    });

    it("answers only mentions on Slack and Telegram, so the two bots never both run on one message", async () => {
      const [first, second] = [await loadSelfConfig(), await loadSelfConfig(SELF_ROOT_2)];
      expect(second.bot).toBe("centaur-test-2");
      expect(second.bot).not.toBe(first.bot);
      expect(second.platforms).toEqual({
        slack: { respond_to: "mention", bot_messages: "mention" },
        telegram: { respond_to: "mention", bot_messages: "ignore" },
      });
      expect(second.chat_tools.scope).toBe("chat");
      expect(second.mcp_servers).toEqual({});
      expect(readFileSync(selfPath(second.persona, SELF_ROOT_2), "utf8")).not.toBe("");
    });
  });

  describe("the self-development bot", () => {
    it("lives at apps/centaur-dev/.centaur/config.yml, so the one-style rule holds", async () => {
      expect(await findConfigFile(".", SELF_ROOT_DEV)).toBe(
        selfPath(".centaur/config.yml", SELF_ROOT_DEV),
      );
      await expect(assertSingleConfigStyle(".", SELF_ROOT_DEV)).resolves.toBeUndefined();
    });

    it("uses a distinct bot name, answers only mentions in pull_request mode, and points at files that exist", async () => {
      const [first, second, dev] = await Promise.all([
        loadSelfConfig(),
        loadSelfConfig(SELF_ROOT_2),
        loadSelfConfig(SELF_ROOT_DEV),
      ]);
      expect(dev.bot).toBe("centaur-dev");
      expect(new Set([first.bot, second.bot, dev.bot]).size).toBe(SELF_ROOTS.length);
      expect(dev.platforms).toEqual({
        slack: { respond_to: "mention", bot_messages: "ignore" },
      });
      expect(dev.execution.mode).toBe("pull_request");
      expect(dev.mcp_servers).toEqual({});
      expect(dev.prompts["next-task"]?.file).toBe(".centaur/prompts/next-task.md");
      for (const file of [dev.persona, dev.prompts["next-task"]?.file ?? "", "AGENTS.md"]) {
        expect(readFileSync(selfPath(file, SELF_ROOT_DEV), "utf8").trim()).not.toBe("");
      }
    });

    it("installs the repository-root AGENTS.md ahead of apps/centaur-dev/AGENTS.md within max_bytes", async () => {
      const dev = await loadSelfConfig(SELF_ROOT_DEV);
      expect(dev.repository_instructions.include_repo_root).toBe(true);
      await expect(installSelfInstructions(SELF_ROOT_DEV, dev)).resolves.toEqual([
        "AGENTS.md",
        "apps/centaur-dev/AGENTS.md",
      ]);
    });
  });

  describe("workflow wiring", () => {
    it("registers every self-consumer root and triggers on each root's config paths", () => {
      const register = loadWorkflow("centaur-register.yml");
      expect(register.jobs.register?.strategy?.matrix?.root).toEqual([...SELF_ROOTS]);
      expect(register.on?.push?.paths).toEqual(
        SELF_ROOTS.flatMap((root) => [`${root}/.centaur.yml`, `${root}/.centaur/**`]),
      );
    });

    it.each([
      [SELF_ROOT, "centaur-test-message.yml"],
      [SELF_ROOT_2, "centaur-test-2-message.yml"],
      [SELF_ROOT_DEV, "centaur-dev-message.yml"],
    ])("routes %s dispatches through %s with matching bot and root", async (root, file) => {
      const config = await loadSelfConfig(root);
      const turn = loadWorkflow(file).jobs.turn;
      expect(turn?.if).toBe(`github.event.client_payload.bot == '${config.bot}'`);
      expect(turn?.uses).toBe("./.github/workflows/centaur-turn.yml");
      expect(turn?.with).toMatchObject({ bot: config.bot, root });
      if (turn?.with?.timeout_minutes !== undefined) {
        expect(turn.with.timeout_minutes).toBeGreaterThan(0);
      }
    });

    it.each([
      [SELF_ROOT, "centaur-pr-comment.yml"],
      [SELF_ROOT_2, "centaur-test-2-pr-comment.yml"],
      [SELF_ROOT_DEV, "centaur-dev-pr-comment.yml"],
    ])(
      "answers %s pull request comments through %s with matching bot and root",
      async (root, file) => {
        const config = await loadSelfConfig(root);
        const workflow = loadWorkflow(file);
        expect(workflow.jobs.comment?.uses).toBe("./.github/workflows/centaur-comment-turn.yml");
        expect(workflow.jobs.comment?.with).toMatchObject({ bot: config.bot, root });
        expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
          "issue_comment",
          "pull_request_review",
        ]);
      },
    );

    it("gives every bot's comment caller the timeout of its message caller, used by the comment turn job", () => {
      const reusable = loadWorkflow("centaur-comment-turn.yml");
      expect(reusable.on?.workflow_call?.inputs?.timeout_minutes?.type).toBe("number");
      expect(reusable.jobs.turn?.["timeout-minutes"]).toMatch(/inputs\.timeout_minutes/);
      for (const [message, comment] of [
        ["centaur-test-message.yml", "centaur-pr-comment.yml"],
        ["centaur-test-2-message.yml", "centaur-test-2-pr-comment.yml"],
        ["centaur-dev-message.yml", "centaur-dev-pr-comment.yml"],
      ] as const) {
        expect(loadWorkflow(comment).jobs.comment?.with?.timeout_minutes).toBe(
          loadWorkflow(message).jobs.turn?.with?.timeout_minutes,
        );
      }
    });

    it("runs the dev bot's next-task prompt on a weekday schedule, serialized on the resolved group", async () => {
      const workflow = loadWorkflow("centaur-dev-next-task.yml");
      const { resolve, "next-task": job } = workflow.jobs;
      const dev = await loadSelfConfig(SELF_ROOT_DEV);
      const resolveStep = resolve?.steps?.find((step) => step.id === "resolve");
      const turnStep = job?.steps?.find((step) => step.uses?.endsWith("actions/turn"));
      expect(workflow.on?.schedule).toHaveLength(1);
      expect(workflow.on?.schedule?.[0]?.cron.split(" ").at(-1)).toBe("1-5");
      expect(Object.keys(dev.prompts)).toContain("next-task");
      expect(resolveStep?.with).toEqual({ root: SELF_ROOT_DEV });
      expect(turnStep?.with).toMatchObject({ root: SELF_ROOT_DEV, prompt_name: "next-task" });
      expect(job?.needs).toBe("resolve");
      expect(job?.concurrency?.group).toMatch(/^\$\{\{ needs\.resolve\.outputs\.group \}\}$/);
      expect(job?.["timeout-minutes"]).toBe(
        loadWorkflow("centaur-dev-message.yml").jobs.turn?.with?.timeout_minutes,
      );
    });
  });
});
