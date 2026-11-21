import { z } from "zod";
import { type CentaurConfig, type ConfigIssue, formatIssues } from "../config/index.js";
import { checkMcpPolicy, type PolicyLayer, type PolicyLayers } from "../config/mcp-policy.js";
import type { PosterClient } from "./aws.js";
import { GitHubRequestError, type GitHubRequester } from "./resolve.js";

export const MCP_POLICY_FILE = ".centaur/mcp-policy.cedar";

export interface McpPolicyDeps {
  repository: string;
  github: GitHubRequester;
  poster: PosterClient;
}

const repositoryResponse = z.object({ default_branch: z.string().min(1) });
const globalPolicyResponse = z.object({ policy: z.string().nullable() });

/** Reads the repo layer from the default branch, never the checkout: a turn can run on any branch. */
async function fetchRepoPolicy({ repository, github }: McpPolicyDeps) {
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

/** The global layer is bundled with the poster Lambda; `null` means none is deployed. */
async function fetchGlobalPolicy({ poster }: McpPolicyDeps) {
  const { policy } = globalPolicyResponse.parse(await poster.call({ operation: "get-mcp-policy" }));
  return policy ?? undefined;
}

const unreadable = (layer: PolicyLayer) => (error: unknown) => {
  throw new Error(`cannot read the ${layer} operator policy: ${(error as Error).message}`);
};

const denyAll = (servers: CentaurConfig["mcp_servers"], message: string): ConfigIssue[] =>
  Object.keys(servers).map((name) => ({ path: `mcp_servers.${name}`, message }));

async function evaluateRepositoryPolicy(
  config: CentaurConfig,
  deps: McpPolicyDeps | undefined,
): Promise<{ issues: ConfigIssue[]; layers?: PolicyLayers }> {
  const servers = config.mcp_servers;
  if (Object.keys(servers).length === 0) return { issues: [] };
  if (!deps) {
    return { issues: denyAll(servers, "cannot read the operator policy without a GitHub token") };
  }
  let layers: PolicyLayers;
  try {
    layers = {
      global: await fetchGlobalPolicy(deps).catch(unreadable("global")),
      repo: await fetchRepoPolicy(deps).catch(unreadable("repo")),
    };
  } catch (error) {
    return { issues: denyAll(servers, (error as Error).message) };
  }
  if (layers.global === undefined && layers.repo === undefined) {
    return {
      issues: denyAll(
        servers,
        `no global operator policy and no ${MCP_POLICY_FILE} on the default branch`,
      ),
    };
  }
  return { issues: checkMcpPolicy(config.bot, servers, layers), layers };
}

export async function checkRepositoryMcpPolicy(
  config: CentaurConfig,
  deps: McpPolicyDeps | undefined,
): Promise<ConfigIssue[]> {
  return (await evaluateRepositoryPolicy(config, deps)).issues;
}

/** Throws unless every server is permitted; returns the layers read, or undefined without servers. */
export async function enforceMcpPolicy(config: CentaurConfig, deps: McpPolicyDeps | undefined) {
  const { issues, layers } = await evaluateRepositoryPolicy(config, deps);
  if (issues.length > 0) {
    throw new Error(`mcp_servers violate the operator policy:\n${formatIssues(issues)}`);
  }
  return layers;
}
