import { z } from "zod";
import { type CentaurConfig, type ConfigIssue, formatIssues } from "../config/index.js";
import { checkMcpPolicy } from "../config/mcp-policy.js";
import { GitHubRequestError, type GitHubRequester } from "./resolve.js";

export const MCP_POLICY_FILE = ".centaur/mcp-policy.cedar";

export interface McpPolicyDeps {
  repository: string;
  github: GitHubRequester;
}

const repositoryResponse = z.object({ default_branch: z.string().min(1) });

/** Reads the policy from the default branch, never the checkout: a turn can run on any branch. */
async function fetchPolicy({ repository, github }: McpPolicyDeps) {
  const { default_branch } = await github.json(`/repos/${repository}`, repositoryResponse);
  try {
    return await github.text(
      `/repos/${repository}/contents/${MCP_POLICY_FILE}?ref=${encodeURIComponent(default_branch)}`,
      "application/vnd.github.raw+json",
    );
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return undefined;
    throw error;
  }
}

const denyAll = (servers: CentaurConfig["mcp_servers"], message: string): ConfigIssue[] =>
  Object.keys(servers).map((name) => ({ path: `mcp_servers.${name}`, message }));

export async function checkRepositoryMcpPolicy(
  config: CentaurConfig,
  deps: McpPolicyDeps | undefined,
): Promise<ConfigIssue[]> {
  const servers = config.mcp_servers;
  if (Object.keys(servers).length === 0) return [];
  if (!deps) return denyAll(servers, "cannot read the operator policy without a GitHub token");
  let policy: string | undefined;
  try {
    policy = await fetchPolicy(deps);
  } catch (error) {
    return denyAll(servers, `cannot read the operator policy: ${(error as Error).message}`);
  }
  return policy === undefined
    ? denyAll(servers, `no ${MCP_POLICY_FILE} on the default branch`)
    : checkMcpPolicy(config.bot, servers, policy);
}

export async function enforceMcpPolicy(config: CentaurConfig, deps: McpPolicyDeps | undefined) {
  const issues = await checkRepositoryMcpPolicy(config, deps);
  if (issues.length > 0) {
    throw new Error(`mcp_servers violate the operator policy:\n${formatIssues(issues)}`);
  }
}
