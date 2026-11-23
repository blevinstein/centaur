import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { createTwoFilesPatch } from "diff";
import { formatIssues, parseCentaurConfig } from "../../config/index.js";
import { checkMcpPolicy, validateMcpPolicy } from "../../config/mcp-policy.js";
import { configRepoRoot, findConfigFile } from "../../workflows/config-file.js";
import { MCP_POLICY_FILE } from "../../workflows/mcp-policy-check.js";
import { ConfigMigrationError, migrateConfigText } from "../config-migration.js";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";

const asCliError = (error: Error): never => {
  throw new CliError(error.message);
};

async function readConfig(explicitPath: string | undefined) {
  const path = explicitPath ?? (await findConfigFile(process.cwd()).catch(asCliError));
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
    );
  });
  return { path, text };
}

export function registerConfigCommands(program: Command, context: CliContext): void {
  const config = program.command("config").description("Work with a repo's Centaur config");

  config
    .command("check [path]")
    .option(
      "--global-policy <path>",
      "also check against this global operator policy (the deployer's infra/mcp-policy.cedar)",
    )
    .description(
      "Validate a config file offline (default: .centaur/config.yml or .centaur.yml in the current directory); with mcp_servers, also check them against .centaur/mcp-policy.cedar at the repo root (the local copy, unlike registration and turns, which read the default branch)",
    )
    .action(async (explicitPath: string | undefined, options: { globalPolicy?: string }) => {
      const { path, text } = await readConfig(explicitPath);
      const result = parseCentaurConfig(text);
      if (!result.ok) throw new CliError(`${path} is invalid:\n${formatIssues(result.issues)}`);
      if (Object.keys(result.config.mcp_servers).length > 0) {
        const policyPath = join(configRepoRoot(path), MCP_POLICY_FILE);
        const policy = await readFile(policyPath, "utf8").catch(() => {
          throw new CliError(`${path} has mcp_servers but ${policyPath} cannot be read`);
        });
        const global =
          options.globalPolicy === undefined
            ? undefined
            : await readFile(options.globalPolicy, "utf8").catch(() => {
                throw new CliError(`Cannot read ${options.globalPolicy}`);
              });
        const problems = [
          ...validateMcpPolicy(policy).map((message) => `${MCP_POLICY_FILE}: ${message}`),
          ...(global === undefined
            ? []
            : validateMcpPolicy(global, "global").map(
                (message) => `${options.globalPolicy}: ${message}`,
              )),
          ...formatIssues(
            checkMcpPolicy(result.config.bot, result.config.mcp_servers, { global, repo: policy }),
          )
            .split("\n")
            .filter(Boolean),
        ];
        if (problems.length > 0) {
          throw new CliError(`${path} violates the MCP policy:\n${problems.join("\n")}`);
        }
      }
      context.log(`${path} is valid.`);
    });

  config
    .command("migrate [path]")
    .option("--dry-run", "print the diff and leave the file unchanged")
    .description(
      "Rewrite a config that uses the top-level platform, respond_to and handle keys to platforms.<platform>, keeping comments and key order; does nothing when the file is already migrated",
    )
    .action(async (explicitPath: string | undefined, options: { dryRun?: boolean }) => {
      const { path, text } = await readConfig(explicitPath);
      const migrated = await Promise.resolve()
        .then(() => migrateConfigText(text))
        .catch((error: unknown) => {
          throw error instanceof ConfigMigrationError
            ? new CliError(`${path} ${error.message}`)
            : error;
        });
      if (migrated === text) {
        context.log(`${path} already declares platforms; nothing to do.`);
        return;
      }
      if (options.dryRun) {
        context.log(createTwoFilesPatch(path, path, text, migrated).trimEnd());
        return;
      }
      await writeFile(path, migrated);
      context.log(`Migrated ${path}.`);
    });
}
