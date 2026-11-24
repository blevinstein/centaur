import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { McpApprovalStatus } from "../../src/lambda/mcp-approvals.js";
import type { PosterClient } from "../../src/workflows/aws.js";
import { MCP_CONFIG_FILE, type PrepareDeps } from "../../src/workflows/prepare.js";
import { fakePolicyGitHub, PERMIT_WHEN_APPROVED } from "./mcp-policy-fixtures.js";
import { configText } from "./workflow-fixtures.js";

export const LINEAR_SECRET = "lin_secret_value";
export const APPROVAL_ENV = { LINEAR_API_KEY: LINEAR_SECRET };

const LINEAR_YAML = `  linear:
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: { secret: LINEAR_API_KEY, prefix: "Bearer " }`;
const DOCS_YAML = "  docs:\n    command: npx\n    args: ['-y', '@example/docs-mcp@1.0.0']";

export const LINEAR_TOOLS = "mcp__linear__*";

/** `linear` and `docs` servers, `linear` allowed by a wildcard and `docs` by two named tools. */
export const twoServerConfig = (extra = "") =>
  configText(`mcp_servers:\n${LINEAR_YAML}\n${DOCS_YAML}\n${extra}`).replace(
    "Read,Edit",
    `Read,${LINEAR_TOOLS},mcp__docs__search,mcp__docs__list`,
  );

export const linearConfig = (extra = "") =>
  configText(`mcp_servers:\n${LINEAR_YAML}\n${extra}`).replace("Read,Edit", `Read,${LINEAR_TOOLS}`);

export const approvalPolicyDeps = () => fakePolicyGitHub({ policy: PERMIT_WHEN_APPROVED }).deps;

/** A `mcpApprovals` that answers with `statuses`, or throws when given an error. */
export const fakeMcpApprovals = (statuses: Record<string, McpApprovalStatus> | Error) =>
  vi.fn<PosterClient["mcpApprovals"]>(async () => {
    if (statuses instanceof Error) throw statuses;
    return { servers: statuses };
  });

export const posterAnswering = (
  poster: PosterClient,
  mcpApprovals: PosterClient["mcpApprovals"],
): PosterClient => ({ ...poster, mcpApprovals });

/** Deps for a turn whose servers need approval and whose poster answers `mcpApprovals`. */
export const approvalDeps = (
  run: { deps: (overrides?: Partial<PrepareDeps>) => PrepareDeps; aws: { poster: PosterClient } },
  mcpApprovals: PosterClient["mcpApprovals"],
  overrides: Partial<PrepareDeps> = {},
) =>
  run.deps({
    env: APPROVAL_ENV,
    mcpPolicy: approvalPolicyDeps(),
    poster: posterAnswering(run.aws.poster, mcpApprovals),
    ...overrides,
  });

export const readMcpServers = async (root: string): Promise<string[] | undefined> =>
  readFile(join(root, MCP_CONFIG_FILE), "utf8").then(
    (text) => Object.keys(JSON.parse(text).mcpServers),
    () => undefined,
  );

export const allowedToolsOf = (claudeArgs: string) =>
  /--allowedTools "([^"]*)"/.exec(claudeArgs)?.[1]?.split(",") ?? [];
