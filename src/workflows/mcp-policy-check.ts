import { posix } from "node:path";
import { z } from "zod";
import { type CentaurConfig, formatIssues, isRepoRelativePath } from "../config/index.js";
import {
  evaluateMcpPolicy,
  formatApprovals,
  type McpPolicyResult,
  type PolicyLayer,
  type PolicyLayers,
} from "../config/mcp-policy.js";
import { type PolicyLintContext, policyProblems } from "../config/mcp-policy-lint.js";
import { CHAT_SERVER_NAME } from "../mcp/server-config.js";
import type { PosterClient } from "./aws.js";
import { fetchDefaultBranch, GitHubRequestError, type GitHubRequester } from "./resolve.js";

export const MCP_POLICY_FILE = ".centaur/mcp-policy.cedar";

export interface McpPolicyDeps {
  repository: string;
  /** The Centaur root inside the repository (default `.`). */
  root?: string | undefined;
  github: GitHubRequester;
  poster: PosterClient;
}

const globalPolicyResponse = z.object({ policy: z.string().nullable() });

/** The repo-relative path of the policy file for a Centaur root, as a URL path. */
export function mcpPolicyPath(root = "."): string {
  if (!isRepoRelativePath(root)) {
    throw new Error(`Invalid Centaur root "${root}": must be a relative path inside the repo`);
  }
  return posix.join(root, MCP_POLICY_FILE).split("/").map(encodeURIComponent).join("/");
}

/** Reads the repo layer from the default branch, never the checkout: a turn can run on any branch. */
async function fetchRepoPolicy({ repository, root, github }: McpPolicyDeps) {
  const defaultBranch = await fetchDefaultBranch(github, repository);
  try {
    return await github.text(
      `/repos/${repository}/contents/${mcpPolicyPath(root)}?ref=${encodeURIComponent(defaultBranch)}`,
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

/** The server and tool names a policy's literals are checked against, the chat server included. */
export function policyLintContext(config: CentaurConfig): PolicyLintContext {
  const chat = config.chat_tools.scope === "chat";
  return {
    servers: [...Object.keys(config.mcp_servers), ...(chat ? [CHAT_SERVER_NAME] : [])],
    allowedTools: [...config.allowed_tools, ...(chat ? [`mcp__${CHAT_SERVER_NAME}__*`] : [])],
  };
}

const denyAll = (servers: CentaurConfig["mcp_servers"], message: string): McpPolicyResult => ({
  issues: Object.keys(servers).map((name) => ({ path: `mcp_servers.${name}`, message })),
  approvals: [],
});

export async function checkRepositoryMcpPolicy(
  config: CentaurConfig,
  deps: McpPolicyDeps | undefined,
): Promise<McpPolicyResult & { layers?: PolicyLayers; warnings?: string[] }> {
  const servers = config.mcp_servers;
  if (Object.keys(servers).length === 0) return { issues: [], approvals: [] };
  if (!deps) return denyAll(servers, "cannot read the operator policy without a GitHub token");
  let layers: PolicyLayers;
  try {
    layers = {
      global: await fetchGlobalPolicy(deps).catch(unreadable("global")),
      repo: await fetchRepoPolicy(deps).catch(unreadable("repo")),
    };
  } catch (error) {
    return denyAll(servers, (error as Error).message);
  }
  if (layers.global === undefined && layers.repo === undefined) {
    return denyAll(
      servers,
      `no global operator policy and no ${MCP_POLICY_FILE} on the default branch`,
    );
  }
  const { errors, warnings } = policyProblems(layers, policyLintContext(config));
  if (errors.length > 0) {
    return denyAll(
      servers,
      `operator policy is invalid: ${errors.map(({ layer, message }) => `${layer}: ${message}`).join("; ")}`,
    );
  }
  return {
    ...evaluateMcpPolicy(config.bot, servers, layers, config.allowed_tools),
    layers,
    warnings: warnings.map(({ layer, message }) => `${layer}: ${message}`),
  };
}

/**
 * Throws unless every server is permitted and both layers validate without warnings. Returns the
 * approvals and the layers read, which are undefined for a config without servers.
 */
export async function enforceMcpPolicy(config: CentaurConfig, deps: McpPolicyDeps | undefined) {
  const { issues, approvals, layers, warnings = [] } = await checkRepositoryMcpPolicy(config, deps);
  if (issues.length > 0) {
    throw new Error(`mcp_servers violate the operator policy:\n${formatIssues(issues)}`);
  }
  for (const warning of warnings) console.log(`::warning::operator policy: ${warning}`);
  if (approvals.length > 0) console.log(`::notice::${formatApprovals(approvals)}`);
  return { approvals, layers };
}
