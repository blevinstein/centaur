import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { formatIssues, parseCentaurConfig } from "../../config/index.js";
import { evaluateMcpPolicy, formatApprovals, type PolicyLayers } from "../../config/mcp-policy.js";
import { policyProblems } from "../../config/mcp-policy-lint.js";
import { configRepoRoot, findConfigFile } from "../../workflows/config-file.js";
import { MCP_POLICY_FILE, policyLintContext } from "../../workflows/mcp-policy-check.js";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";

const asCliError = (error: Error): never => {
  throw new CliError(error.message);
};

export async function readConfig(explicitPath: string | undefined, root: string | undefined) {
  const path = explicitPath ?? (await findConfigFile(process.cwd(), root).catch(asCliError));
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
    );
  });
  return { path, text };
}

/** The local repo layer next to the config, and the global layer when a file is given. */
export async function readPolicyLayers(
  configPath: string,
  globalPolicy: string | undefined,
): Promise<Required<PolicyLayers>> {
  const policyPath = join(configRepoRoot(configPath), MCP_POLICY_FILE);
  const repo = await readFile(policyPath, "utf8").catch(() => {
    throw new CliError(`${configPath} has mcp_servers but ${policyPath} cannot be read`);
  });
  const global =
    globalPolicy === undefined
      ? undefined
      : await readFile(globalPolicy, "utf8").catch(() => {
          throw new CliError(`Cannot read ${globalPolicy}`);
        });
  return { repo, global };
}

export const GLOBAL_POLICY_OPTION = [
  "--global-policy <path>",
  "also check against this global operator policy (the deployer's infra/mcp-policy.cedar)",
] as const;

export function registerConfigCommands(program: Command, context: CliContext): void {
  const config = program.command("config").description("Work with a repo's Centaur config");

  config
    .command("check [path]")
    .option(...GLOBAL_POLICY_OPTION)
    .option("--root <dir>", "the Centaur root, relative to the current directory (default: .)")
    .description(
      "Validate a config file offline (default: .centaur/config.yml or .centaur.yml in the current directory or --root); with mcp_servers, also check them against .centaur/mcp-policy.cedar next to the config (the local copy, unlike registration and turns, which read the default branch)",
    )
    .action(
      async (
        explicitPath: string | undefined,
        options: { globalPolicy?: string; root?: string },
      ) => {
        const { path, text } = await readConfig(explicitPath, options.root);
        const result = parseCentaurConfig(text);
        if (!result.ok) throw new CliError(`${path} is invalid:\n${formatIssues(result.issues)}`);
        let notice: string | undefined;
        let warnings: string[] = [];
        if (Object.keys(result.config.mcp_servers).length > 0) {
          const layers = await readPolicyLayers(path, options.globalPolicy);
          const { issues, approvals } = evaluateMcpPolicy(
            result.config.bot,
            result.config.mcp_servers,
            layers,
            result.config.allowed_tools,
          );
          if (approvals.length > 0) notice = formatApprovals(approvals);
          const lint = policyProblems(layers, policyLintContext(result.config));
          const source = { repo: MCP_POLICY_FILE, global: options.globalPolicy };
          const problems = [
            ...lint.errors.map(({ layer, message }) => `${source[layer]}: ${message}`),
            ...formatIssues(issues).split("\n").filter(Boolean),
          ];
          warnings = lint.warnings.map(({ layer, message }) => `${source[layer]}: ${message}`);
          if (problems.length > 0) {
            throw new CliError(`${path} violates the MCP policy:\n${problems.join("\n")}`);
          }
        }
        context.log(`${path} is valid.`);
        if (notice) context.log(`Notice: ${notice}`);
        for (const warning of warnings) context.log(`Warning: ${warning}`);
      },
    );
}
