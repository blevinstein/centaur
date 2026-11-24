import type { CentaurConfig, McpServer, SecretRef } from "../config/index.js";
import type { McpApproval } from "../config/mcp-policy.js";
import { mcpToolMatchesServer } from "../config/schema.js";
import { MCP_SUMMARY_MAX, type McpApprovalStatus } from "../lambda/mcp-approvals.js";
import type { PosterClient } from "./aws.js";

/** The thread and triggering message a request is raised for; a turn without them can only read. */
export interface ApprovalThread {
  threadId: string;
  messageId: string;
}

export const approvalThread = (threadId: string, messageId: string | undefined) =>
  messageId ? { threadId, messageId } : undefined;

export interface McpApprovalNotice {
  pending: { name: string; tools: string[] }[];
  denied: string[];
}

export interface McpApprovalOutcome {
  /** Servers that stay out of this turn: pending and denied. */
  dropped: Set<string>;
  notice: McpApprovalNotice;
}

export interface AskDeps {
  poster: Pick<PosterClient, "mcpApprovals">;
  fetchToken: () => Promise<string>;
}

const secretNames = (values: Record<string, string | SecretRef> | undefined) =>
  Object.values(values ?? {}).flatMap((value) => (typeof value === "string" ? [] : [value.secret]));

const secretsPart = (names: string[]) => (names.length > 0 ? [`secrets: ${names.join(", ")}`] : []);

const serverTools = (name: string, allowedTools: string[]) =>
  allowedTools.filter((tool) => mcpToolMatchesServer(tool, name));

/** One line for the admin: transport, host or command, secret names and allowed tools; no values. */
export function describeMcpApproval(name: string, server: McpServer, allowedTools: string[]) {
  const parts =
    "url" in server
      ? [`remote ${new URL(server.url).host}`, ...secretsPart(secretNames(server.headers))]
      : [
          `stdio ${[server.command, ...(server.args ?? [])].join(" ")}`,
          ...secretsPart(secretNames(server.env)),
        ];
  return [...parts, `tools: ${serverTools(name, allowedTools).join(", ")}`]
    .join("; ")
    .slice(0, MCP_SUMMARY_MAX);
}

/**
 * Asks the poster once for every approval-required server's decision. A failed call maps every
 * server to `pending`: a failure never approves a server and never fails the turn. Without a thread
 * the call is read-only: it reports stored decisions and raises no request.
 */
export async function askApprovals(
  deps: AskDeps,
  config: CentaurConfig,
  approvals: McpApproval[],
  thread: ApprovalThread | undefined,
): Promise<McpApprovalOutcome> {
  let statuses: Record<string, McpApprovalStatus> = {};
  try {
    ({ servers: statuses } = await deps.poster.mcpApprovals({
      token: await deps.fetchToken(),
      bot: config.bot,
      ...thread,
      servers: approvals.map(({ name, key }) => ({
        name,
        fingerprint: key.slice(name.length + 1),
        summary: describeMcpApproval(
          name,
          config.mcp_servers[name] as McpServer,
          config.allowed_tools,
        ),
      })),
    }));
  } catch (error) {
    console.warn(
      `::warning::Could not read MCP server approvals (${(error as Error).name}); treating them as pending`,
    );
  }
  const named = (status: McpApprovalStatus) =>
    approvals.map(({ name }) => name).filter((name) => (statuses[name] ?? "pending") === status);
  const pending = named("pending");
  const denied = named("denied");
  return {
    dropped: new Set([...pending, ...denied]),
    notice: {
      pending: pending.map((name) => ({ name, tools: serverTools(name, config.allowed_tools) })),
      denied,
    },
  };
}

export const NO_DROPPED: McpApprovalOutcome = {
  dropped: new Set(),
  notice: { pending: [], denied: [] },
};

/** Removes dropped servers' entries and tool rules from what the turn starts. */
export const withoutServers = <T>(
  dropped: Set<string>,
  servers: Record<string, T>,
  allowedTools: string[],
) => ({
  servers: Object.fromEntries(Object.entries(servers).filter(([name]) => !dropped.has(name))),
  allowedTools: allowedTools.filter(
    (tool) => ![...dropped].some((name) => mcpToolMatchesServer(tool, name)),
  ),
});
