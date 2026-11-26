import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/workflows/aws.js";
import { stepEnvsRunning } from "./action-fixtures.js";
import { DIRECT_EXECUTION } from "./helpers/config-fixtures.js";
import { commitFile, createClone, git } from "./helpers/git-fixtures.js";
import { issueComment } from "./helpers/resolve-fixtures.js";
import {
  createRunnerEnv,
  readOutputs,
  runWorkflowCommand,
  stubFetch,
} from "./helpers/workflow-cli-fixtures.js";
import { configText, createFakeAws } from "./helpers/workflow-fixtures.js";

const routed = vi.hoisted(() => ({ aws: undefined as Exec | undefined }));

vi.mock("../src/workflows/aws.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/workflows/aws.js")>();
  return {
    ...original,
    execCommand: (file: string, args: string[]) =>
      file === "aws"
        ? (routed.aws ?? (() => Promise.reject(new Error("aws is not available"))))(file, args)
        : original.execCommand(file, args),
  };
});

const DIRECT_CONFIG = configText(
  `${DIRECT_EXECUTION}\nprompts: {weekly: {destination: household}}`,
);
const OPTIONAL_STEP_VALUES = {
  CENTAUR_ROOT: "",
  CENTAUR_CONFIG_ROOT: "",
  COMMENT_PULL_REQUEST: "",
  PROMPT_NAME: "weekly",
};
const PULL_REQUEST_ROUTES = {
  "oidc.test": { value: "jwt" },
  "/collaborators/sam/permission": { permission: "write" },
  "/pulls/12": {
    state: "open",
    head: { ref: "centaur/sprout-abc123def456", repo: { full_name: "octo/sprout" } },
    base: { repo: { full_name: "octo/sprout" } },
  },
};

describe("the workflow CLI", () => {
  it("resolves a comment on a linked pull request", async () => {
    const aws = createFakeAws(() => ({ found: true, bot: "sprout", threadKey: "0123456789ab" }));
    routed.aws = aws.exec;
    stubFetch(PULL_REQUEST_ROUTES);
    const { env, output } = await createRunnerEnv({
      files: { ".centaur.yml": configText() },
      event: issueComment(),
      env: { GITHUB_EVENT_NAME: "issue_comment", GITHUB_TOKEN: "ghs" },
    });

    const result = await runWorkflowCommand("resolve", env);

    expect(result.exitCode).toBeUndefined();
    expect(await readOutputs(output)).toEqual({
      skip: "false",
      bot: "sprout",
      thread_key: "0123456789ab",
      head_ref: "centaur/sprout-abc123def456",
      pull_request: "12",
    });
  });

  it("skips a comment from a bot", async () => {
    stubFetch();
    const { env, output } = await createRunnerEnv({
      files: { ".centaur.yml": configText() },
      event: issueComment({ sender: { type: "Bot", login: "ci[bot]" } }),
      env: { GITHUB_EVENT_NAME: "issue_comment", GITHUB_TOKEN: "ghs" },
    });

    const result = await runWorkflowCommand("resolve", env);

    expect(result.logs).toEqual([expect.stringMatching(/^Skipping: /)]);
    expect(await readOutputs(output)).toEqual({ skip: "true" });
  });

  it("writes a scheduled prompt's concurrency group", async () => {
    const { env, output } = await createRunnerEnv({
      files: { ".centaur.yml": configText("prompts: {weekly: {destination: household}}") },
      env: { PROMPT_NAME: "weekly" },
    });

    await runWorkflowCommand("resolve-schedule", env);

    expect(await readOutputs(output)).toEqual({ group: "centaur-sprout-weekly-42" });
  });

  describe("plan-pr", () => {
    it.each([
      ["a pull request config", configText(), { target: "thread", fallback_reason: "" }],
      ["a direct config", DIRECT_CONFIG, { target: "direct" }],
    ])("plans from %s without a token", async (_name, config, expected) => {
      const { env, output, workspace } = await createRunnerEnv({
        files: { ".centaur.yml": config, "execution.json": "{}" },
      });

      await runWorkflowCommand("plan-pr", {
        ...env,
        EXECUTION_FILE: `${workspace}/execution.json`,
      });

      expect(await readOutputs(output)).toEqual(expected);
    });
  });

  describe("push-direct", () => {
    const directClone = async () => {
      const clone = await createClone();
      await commitFile(clone.work, ".centaur.yml", DIRECT_CONFIG);
      await clone.write("new.md", "hello\n");
      const runner = await createRunnerEnv({
        env: {
          GITHUB_TOKEN: "ghs",
          RUN_URL: "https://github.com/octo/sprout/actions/runs/9",
          PR_TITLE: "Add hello",
        },
      });
      return {
        ...clone,
        output: runner.output,
        env: { ...runner.env, GITHUB_WORKSPACE: clone.work, RUNNER_TEMP: clone.base },
      };
    };

    it("refuses when the committed config does not say direct", async () => {
      stubFetch();
      const { env, output } = await createRunnerEnv({ files: { ".centaur.yml": configText() } });

      const result = await runWorkflowCommand("push-direct", env);

      expect(result.exitCode).toBeUndefined();
      expect(result.logs).toEqual([expect.stringContaining("::notice::Not pushing directly")]);
      expect(await readOutputs(output)).toEqual({ fallback: "true", reason: "not_direct" });
    });

    it("reports the branch and commit it pushed", async () => {
      stubFetch({ "/repos/octo/sprout": { default_branch: "main" } });
      const { env, output, remote } = await directClone();

      await runWorkflowCommand("push-direct", env);

      const outputs = await readOutputs(output);
      expect(outputs).toEqual({
        fallback: "false",
        reason: "",
        branch: "main",
        "commit-sha": expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(outputs["commit-sha"]).toBe((await git(remote, "rev-parse", "main")).trim());
    });

    it("falls back with the reason when the push is rejected", async () => {
      stubFetch({ "/repos/octo/sprout": { default_branch: "main" } });
      const { env, output, rejectPushes } = await directClone();
      await rejectPushes();

      const result = await runWorkflowCommand("push-direct", env);

      const outputs = await readOutputs(output);
      expect(outputs).toMatchObject({ fallback: "true", branch: "main" });
      expect(outputs.reason).not.toBe("");
      expect(outputs).not.toHaveProperty("commit-sha");
      expect(result.logs).toEqual([
        expect.stringContaining(`::notice::Could not push to main (${outputs.reason})`),
      ]);
    });
  });

  it("exits non-zero with an ::error:: annotation when a command fails", async () => {
    const { env } = await createRunnerEnv({ env: { PROMPT_NAME: "weekly" } });

    const result = await runWorkflowCommand("resolve-schedule", env);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([expect.stringMatching(/^::error::No Centaur config in /)]);
  });

  it("keeps a multi-line failure on one annotation line", async () => {
    const { env } = await createRunnerEnv({
      files: { ".centaur.yml": "bot: [" },
      env: { PROMPT_NAME: "weekly" },
    });

    const result = await runWorkflowCommand("resolve-schedule", env);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^::error::The Centaur config is invalid:%0A/);
    expect(result.errors[0]).not.toContain("\n");
  });

  describe("env wiring", () => {
    const COMMANDS = [
      "register",
      "resolve",
      "resolve-schedule",
      "prepare",
      "plan-pr",
      "push-existing",
      "push-direct",
      "pr-details",
      "audit-tool-calls",
      "finish",
      "notify-failure",
    ];

    it.each(COMMANDS)(
      "%s finds every required env name its composite action step sets",
      async (command) => {
        stubFetch();
        const stepEnvs = stepEnvsRunning(command);
        expect(stepEnvs.length).toBeGreaterThan(0);
        for (const stepEnv of stepEnvs) {
          const provided = Object.fromEntries(Object.keys(stepEnv).map((name) => [name, "1"]));
          const { env } = await createRunnerEnv({
            files: { ".centaur.yml": DIRECT_CONFIG },
            env: { ...provided, ...OPTIONAL_STEP_VALUES },
          });

          const { errors } = await runWorkflowCommand(command, env);

          expect(errors.filter((line) => line.includes(" is not set"))).toEqual([]);
        }
      },
    );
  });
});
