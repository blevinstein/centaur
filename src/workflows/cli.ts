import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createAttachmentDownloader, createPosterClient, createThreadStore } from "./aws.js";
import { cleanTitle } from "./clean-text.js";
import { parseConfigOrThrow, readConfigText } from "./config-file.js";
import { requireEnv as env } from "./env.js";
import { finish, notifyFailure } from "./finish.js";
import { maskValue, writeOutputs } from "./github-output.js";
import { oidcTokenFetcher } from "./oidc-token.js";
import { createPullRequestTargetClient, planForTurn, planOutputs } from "./pr-target.js";
import { prepare } from "./prepare.js";
import { describePullRequest } from "./pull-request.js";
import { createPullRequestReader, createPullRequestWriter } from "./pull-request-comments.js";
import { pushChanges, pushNewBranch } from "./push.js";
import { pushExisting } from "./push-existing.js";
import { registerRepo } from "./register.js";
import { createGitHubClient, createGitHubRequester, resolve } from "./resolve.js";
import { scheduleGroup } from "./schedule-group.js";
import { turnStateDir } from "./turn-state.js";

const poster = () => createPosterClient(env("CENTAUR_FUNCTION_NAME"));
const storeFor = (bot: string, threadId: string) =>
  createThreadStore(env("CENTAUR_SESSION_BUCKET"), bot, threadId);
const attachments = () => createAttachmentDownloader(env("CENTAUR_SESSION_BUCKET"));
const workspace = () => process.env.GITHUB_WORKSPACE ?? process.cwd();

const readEvent = async () => JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8"));

async function clientPayload() {
  return ((await readEvent()) as { client_payload?: unknown }).client_payload;
}

const program = new Command("centaur-workflow");

const mcpPolicyDeps = () => {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) return undefined;
  return {
    repository,
    github: createGitHubRequester(token, process.env.GITHUB_API_URL),
    poster: poster(),
  };
};

program.command("register").action(async () => {
  const result = await registerRepo({
    workspace: workspace(),
    mcpPolicy: mcpPolicyDeps(),
    poster: poster(),
    fetchToken: oidcTokenFetcher(process.env, env("CENTAUR_OIDC_AUDIENCE")),
    mask: maskValue,
  });
  console.log(`Registered bot "${result.bot}" for ${result.repo}`);
});

program.command("resolve").action(async () => {
  const outcome = await resolve({
    eventName: env("GITHUB_EVENT_NAME"),
    event: await readEvent(),
    repository: env("GITHUB_REPOSITORY"),
    github: createGitHubClient(env("GITHUB_TOKEN"), process.env.GITHUB_API_URL),
    commentAuthors: async () =>
      parseConfigOrThrow(await readConfigText(process.env.CENTAUR_CONFIG_ROOT || workspace()))
        .pull_requests.comment_authors,
    poster: poster(),
    fetchToken: oidcTokenFetcher(process.env, env("CENTAUR_OIDC_AUDIENCE")),
    mask: maskValue,
  });
  if (outcome.skip) {
    console.log(`Skipping: ${outcome.reason}`);
    await writeOutputs(env("GITHUB_OUTPUT"), { skip: "true" });
    return;
  }
  await writeOutputs(env("GITHUB_OUTPUT"), {
    skip: "false",
    bot: outcome.bot,
    thread_key: outcome.threadKey,
    head_ref: outcome.headRef,
    pull_request: String(outcome.pullRequest),
  });
});

program.command("resolve-schedule").action(async () => {
  const config = parseConfigOrThrow(
    await readConfigText(process.env.CENTAUR_CONFIG_ROOT || workspace()),
  );
  await writeOutputs(env("GITHUB_OUTPUT"), {
    group: scheduleGroup(config, env("PROMPT_NAME"), env("GITHUB_RUN_ID")),
  });
});

const commentPullRequest = () => {
  if (!process.env.COMMENT_PULL_REQUEST) return undefined;
  const pullRequest = Number(process.env.COMMENT_PULL_REQUEST);
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("COMMENT_PULL_REQUEST is not a pull request number");
  }
  return pullRequest;
};

const oidcFetcher = () => oidcTokenFetcher(process.env, env("CENTAUR_OIDC_AUDIENCE"));

const maskedToken = async () => {
  const token = await oidcFetcher()();
  maskValue(token);
  return token;
};

const commentDeps = () => {
  const pullRequest = commentPullRequest();
  if (!pullRequest) return undefined;
  return {
    pullRequest,
    repository: env("GITHUB_REPOSITORY"),
    github: createPullRequestReader(env("GITHUB_TOKEN"), process.env.GITHUB_API_URL),
    fetchToken: oidcFetcher(),
    mask: maskValue,
  };
};

const targetDeps = () => {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) return undefined;
  return {
    repository,
    github: createPullRequestTargetClient(token, process.env.GITHUB_API_URL),
    fetchToken: () => oidcFetcher()(),
    mask: maskValue,
  };
};

const commentFinishDeps = () => {
  const pullRequest = commentPullRequest();
  if (!pullRequest) return undefined;
  const repository = env("GITHUB_REPOSITORY");
  return {
    repository,
    pullRequestUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/pull/${pullRequest}`,
    github: createPullRequestWriter(env("GITHUB_TOKEN"), process.env.GITHUB_API_URL),
    push: (message: string) => pushChanges(workspace(), message),
  };
};

const newPullRequestDeps = async () => {
  const config = parseConfigOrThrow(
    await readConfigText(process.env.CENTAUR_CONFIG_ROOT || workspace()),
  );
  if (!config.pull_requests.comment_new) return undefined;
  const runId = env("GITHUB_RUN_ID");
  return {
    runId,
    attempt: env("GITHUB_RUN_ATTEMPT"),
    runUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${env("GITHUB_REPOSITORY")}/actions/runs/${runId}`,
    push: (options: Parameters<typeof pushNewBranch>[1]) => pushNewBranch(workspace(), options),
  };
};

program.command("prepare").action(async () => {
  const outputs = await prepare({
    comment: commentDeps(),
    mcpPolicy: mcpPolicyDeps(),
    targets: targetDeps(),
    workspace: workspace(),
    stateDir: turnStateDir(),
    configRoot: process.env.CENTAUR_CONFIG_ROOT || undefined,
    home: homedir(),
    skillsDir: process.env.CENTAUR_SKILLS_DIR || undefined,
    runId: env("GITHUB_RUN_ID"),
    env: process.env,
    promptName: process.env.PROMPT_NAME || undefined,
    clientPayload: await clientPayload(),
    poster: poster(),
    fetchToken: maskedToken,
    attachments: attachments(),
    storeFor,
  });
  await writeOutputs(env("GITHUB_OUTPUT"), {
    skip: String(outputs.skip),
    thread_id: outputs.thread_id,
    branch: outputs.branch,
    claude_args: outputs.claude_args,
    base_url: outputs.base_url,
    api_key_secret: outputs.api_key_secret,
  });
});

program.command("plan-pr").action(async () => {
  const config = parseConfigOrThrow(
    await readConfigText(process.env.CENTAUR_CONFIG_ROOT || workspace()),
  );
  const targets = targetDeps();
  const plan = await planForTurn(
    targets && { ...targets, bot: config.bot, poster: poster() },
    config.pull_requests.existing,
    await readFile(env("EXECUTION_FILE"), "utf8"),
  );
  if (plan.target === "thread" && plan.fallbackReason) {
    console.log(`::notice::Using the thread's pull request (${plan.fallbackReason})`);
  }
  await writeOutputs(env("GITHUB_OUTPUT"), planOutputs(plan));
});

program.command("push-existing").action(async () => {
  const number = Number(env("TARGET_PR_NUMBER"));
  const repository = env("GITHUB_REPOSITORY");
  const result = await pushExisting({
    workspace: workspace(),
    headRef: env("TARGET_HEAD_REF"),
    number,
    pullRequestUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/pull/${number}`,
    message: cleanTitle(process.env.PR_TITLE) || "Centaur agent changes",
    tempDir: process.env.RUNNER_TEMP || undefined,
  });
  if (!result.ok) console.log(`::notice::Could not update the pull request (${result.reason})`);
  await writeOutputs(env("GITHUB_OUTPUT"), {
    fallback: String(!result.ok),
    reason: result.ok ? "" : result.reason,
    ...(result.ok && result.commits === 1
      ? {
          "pull-request-url": result.url,
          "pull-request-number": String(result.number),
        }
      : {}),
  });
});

program.command("pr-details").action(async () => {
  const details = await describePullRequest({
    stateDir: turnStateDir(),
    executionFile: env("EXECUTION_FILE"),
    runUrl: env("RUN_URL"),
  });
  await writeOutputs(env("GITHUB_OUTPUT"), { ...details });
});

const updatedPullRequestDeps = () => {
  const number = Number(process.env.PULL_REQUEST_NUMBER);
  if (process.env.PULL_REQUEST_UPDATED !== "true" || !Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  const repository = env("GITHUB_REPOSITORY");
  return {
    repository,
    runUrl: env("RUN_URL"),
    number,
    github: createPullRequestWriter(env("GITHUB_TOKEN"), process.env.GITHUB_API_URL),
  };
};

program.command("finish").action(async () => {
  const pullRequestNumber = Number(process.env.PULL_REQUEST_NUMBER);
  const comment = commentFinishDeps();
  return finish({
    stateDir: turnStateDir(),
    executionFile: env("EXECUTION_FILE"),
    comment: comment && { ...comment, newPullRequest: await newPullRequestDeps() },
    updatedPullRequest: updatedPullRequestDeps(),
    fallbackReason: process.env.FALLBACK_REASON || undefined,
    pullRequestUrl: process.env.PULL_REQUEST_URL || undefined,
    pullRequestFailed: process.env.PULL_REQUEST_FAILED === "true",
    runUrl: env("RUN_URL"),
    pullRequestLink: {
      number:
        Number.isInteger(pullRequestNumber) && pullRequestNumber > 0
          ? pullRequestNumber
          : undefined,
      fetchToken: () => oidcFetcher()(),
      mask: maskValue,
    },
    fetchToken: maskedToken,
    poster: poster(),
    storeFor,
  });
});

program.command("notify-failure").action(() =>
  notifyFailure({
    stateDir: turnStateDir(),
    ...(process.env.RUNNER_TEMP && {
      executionFile: join(process.env.RUNNER_TEMP, "claude-execution-output.json"),
    }),
    poster: poster(),
    runUrl: env("RUN_URL"),
    comment: commentFinishDeps(),
  }),
);

program.parseAsync().catch((error: Error) => {
  console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
});
