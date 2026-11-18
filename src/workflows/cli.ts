import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Command } from "commander";
import { createPosterClient, createThreadStore } from "./aws.js";
import { finish, notifyFailure } from "./finish.js";
import { maskValue, writeOutputs } from "./github-output.js";
import { prepare } from "./prepare.js";
import { describePullRequest } from "./pull-request.js";
import { oidcTokenFetcher, registerRepo } from "./register.js";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const poster = () => createPosterClient(env("CENTAUR_FUNCTION_NAME"));
const storeFor = (bot: string, threadId: string) =>
  createThreadStore(env("CENTAUR_SESSION_BUCKET"), bot, threadId);
const workspace = () => process.env.GITHUB_WORKSPACE ?? process.cwd();

async function clientPayload() {
  const event = JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8")) as {
    client_payload?: unknown;
  };
  return event.client_payload;
}

const program = new Command("centaur-workflow");

program.command("register").action(async () => {
  const result = await registerRepo({
    workspace: workspace(),
    poster: poster(),
    fetchToken: oidcTokenFetcher(process.env, env("CENTAUR_OIDC_AUDIENCE")),
    mask: maskValue,
  });
  console.log(`Registered bot "${result.bot}" for ${result.repo}`);
});

program.command("prepare").action(async () => {
  const outputs = await prepare({
    workspace: workspace(),
    home: homedir(),
    runId: env("GITHUB_RUN_ID"),
    promptName: process.env.PROMPT_NAME || undefined,
    clientPayload: await clientPayload(),
    poster: poster(),
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

program.command("pr-details").action(async () => {
  const details = await describePullRequest({
    workspace: workspace(),
    executionFile: env("EXECUTION_FILE"),
    runUrl: env("RUN_URL"),
  });
  await writeOutputs(env("GITHUB_OUTPUT"), { ...details });
});

program.command("finish").action(() =>
  finish({
    workspace: workspace(),
    executionFile: env("EXECUTION_FILE"),
    pullRequestUrl: process.env.PULL_REQUEST_URL || undefined,
    poster: poster(),
    storeFor,
  }),
);

program
  .command("notify-failure")
  .action(() =>
    notifyFailure({ workspace: workspace(), poster: poster(), runUrl: env("RUN_URL") }),
  );

program.parseAsync().catch((error: Error) => {
  console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
});
