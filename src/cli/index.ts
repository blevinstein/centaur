#!/usr/bin/env node
import { CommanderError } from "commander";
import { createTelegramApi } from "../lambda/telegram.js";
import { execCommand } from "../workflows/aws.js";
import { createGitHubRequester } from "../workflows/resolve.js";
import { createChatAccess } from "./chat-access.js";
import { SsmParameterStore } from "./parameter-store.js";
import { buildProgram } from "./program.js";
import { CliError } from "./registry.js";
import { readSecretsFromEnvOrInput } from "./secret-input.js";

const program = buildProgram({
  store: new SsmParameterStore(),
  telegram: createTelegramApi(),
  chatAccess: createChatAccess(),
  readSecrets: readSecretsFromEnvOrInput,
  exec: execCommand,
  github: async () =>
    createGitHubRequester(
      (await execCommand("gh", ["auth", "token"])).trim(),
      process.env.GITHUB_API_URL,
    ),
  log: console.log,
});

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) process.exit(error.exitCode);
  console.error(error instanceof CliError ? error.message : error);
  process.exit(1);
}
