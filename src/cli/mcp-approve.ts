import { readFile } from "node:fs/promises";
import type { CentaurConfig, McpServer } from "../config/index.js";
import { describeServer } from "../config/mcp-policy.js";
import { mcpToolMatchesServer } from "../config/schema.js";
import { parseMcpApprovalKey } from "../lambda/connection-paths.js";
import { fetchDefaultBranchConfig } from "../workflows/default-branch-file.js";
import { checkRepositoryMcpPolicy } from "../workflows/mcp-policy-check.js";
import type { GitHubRequester } from "../workflows/resolve.js";
import { CliError } from "./registry.js";

const secretNames = (entries: Record<string, unknown>) =>
  Object.entries(entries).map(([key, value]) =>
    typeof value === "object" && value !== null ? `${key} (secret)` : key,
  );

/** What a server runs and can reach, without any secret value. */
export function describeDefinition(server: string, entry: McpServer, config: CentaurConfig) {
  const { transport, pinned } = describeServer(entry);
  const tools = config.allowed_tools.filter((tool) => mcpToolMatchesServer(tool, server));
  const lines =
    "url" in entry
      ? [`url: ${entry.url}`, `headers: ${secretNames(entry.headers ?? {}).join(", ") || "none"}`]
      : [
          `command: ${entry.command}`,
          `args: ${(entry.args ?? []).join(" ") || "none"}`,
          `env: ${secretNames(entry.env ?? {}).join(", ") || "none"}`,
          `pinned: ${pinned ? "yes" : "no"}`,
        ];
  return [`transport: ${transport}`, ...lines, `allowed_tools: ${tools.join(", ") || "none"}`];
}

export interface DefinitionToApprove {
  name: string;
  fingerprint: string;
  description: string[];
}

/**
 * Reads the bot's config from the default branch of its repository and returns the definition of
 * the `mcp_servers` entry `server` when the operator policy would let it run only after an approval. `undefined` means the
 * policy allows it outright. A missing, unpinned or forbidden definition throws.
 */
export async function definitionToApprove({
  bot,
  repository,
  root,
  server,
  github,
  globalPolicy,
}: {
  bot: string;
  repository: string;
  root: string | undefined;
  server: string;
  github: GitHubRequester;
  globalPolicy: string | undefined;
}): Promise<DefinitionToApprove | undefined> {
  const config = await fetchDefaultBranchConfig(github, repository, root).catch((error: Error) => {
    throw new CliError(error.message);
  });
  if (config.bot !== bot) {
    throw new CliError(`The config in ${repository} is for bot "${config.bot}", not "${bot}".`);
  }
  const entry = config.mcp_servers[server];
  if (!entry) throw new CliError(`Server "${server}" is not in mcp_servers of ${repository}.`);
  const description = describeDefinition(server, entry, config);
  if ("command" in entry && !describeServer(entry).pinned) {
    throw new CliError(
      `Server "${server}" is not pinned to an exact version or commit and cannot be pre-approved:\n${description.join("\n")}`,
    );
  }
  const poster = { call: async <T>() => ({ policy: globalPolicy ?? null }) as T };
  const { issues, approvals } = await checkRepositoryMcpPolicy(config, {
    repository,
    root,
    github,
    poster,
  });
  const refusal = issues.find(({ path }) => path === `mcp_servers.${server}`);
  if (refusal) {
    throw new CliError(`Server "${server}" violates the operator policy: ${refusal.message}`);
  }
  const approval = approvals.find((candidate) => candidate.name === server);
  return approval && { description, ...parseMcpApprovalKey(approval.key) };
}

export const readGlobalPolicy = (path: string | undefined) =>
  path === undefined
    ? undefined
    : readFile(path, "utf8").catch(() => {
        throw new CliError(`Cannot read ${path}`);
      });
