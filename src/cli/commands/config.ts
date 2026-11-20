import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { formatIssues, parseCentaurConfig } from "../../config/index.js";
import { checkMcpPolicy, validateMcpPolicy } from "../../config/mcp-policy.js";
import { CONFIG_FILE } from "../../workflows/config-file.js";
import { MCP_POLICY_FILE } from "../../workflows/mcp-policy-check.js";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";

export function registerConfigCommands(program: Command, context: CliContext): void {
  const config = program.command("config").description("Work with a repo's .centaur.yml");

  config
    .command("check [path]")
    .description(
      "Validate a config file offline; with mcp_servers, also check them against the sibling .centaur/mcp-policy.cedar (the local copy, unlike registration and turns, which read the default branch)",
    )
    .action(async (path: string = CONFIG_FILE) => {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        throw new CliError(
          `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
        );
      });
      const result = parseCentaurConfig(text);
      if (!result.ok) throw new CliError(`${path} is invalid:\n${formatIssues(result.issues)}`);
      if (Object.keys(result.config.mcp_servers).length > 0) {
        const policyPath = join(dirname(path), MCP_POLICY_FILE);
        const policy = await readFile(policyPath, "utf8").catch(() => {
          throw new CliError(`${path} has mcp_servers but ${policyPath} cannot be read`);
        });
        const problems = [
          ...validateMcpPolicy(policy).map((message) => `${MCP_POLICY_FILE}: ${message}`),
          ...formatIssues(checkMcpPolicy(result.config.bot, result.config.mcp_servers, policy))
            .split("\n")
            .filter(Boolean),
        ];
        if (problems.length > 0) {
          throw new CliError(`${path} violates the MCP policy:\n${problems.join("\n")}`);
        }
      }
      context.log(`${path} is valid.`);
    });
}
