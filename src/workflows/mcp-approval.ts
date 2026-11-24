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

/** A server as the poster's `mcp-approvals` request names it. */
export interface ApprovalServer {
  name: string;
  fingerprint: string;
  summary: string;
}

/**
 * The servers a chat turn may suspend for, kept in the turn state so `finish` validates
 * `suspend_for` against what `prepare` saw instead of trusting the agent.
 */
export interface SuspendableServers {
  thread: ApprovalThread;
  servers: ApprovalServer[];
}

export interface McpApprovalNotice {
  pending: { name: string; tools: string[] }[];
  denied: string[];
}

export interface McpApprovalOutcome {
  /** Servers that stay out of this turn: pending and denied. */
  dropped: Set<string>;
  notice: McpApprovalNotice;
  /** The pending servers whose requests the poster raised; empty when its answer was unavailable. */
  pendingServers: ApprovalServer[];
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

const approvalServers = (config: CentaurConfig, approvals: McpApproval[]): ApprovalServer[] =>
  approvals.map(({ name, key }) => ({
    name,
    fingerprint: key.slice(name.length + 1),
    summary: describeMcpApproval(name, config.mcp_servers[name] as McpServer, config.allowed_tools),
  }));

/** The poster request for `servers`; with a thread it can raise requests, and `suspend` marks them suspended. */
export const approvalsRequest = (
  request: { token: string; bot: string; servers: ApprovalServer[]; suspend?: true },
  thread: ApprovalThread | undefined,
) => ({ ...request, ...thread });

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
  const servers = approvalServers(config, approvals);
  let statuses: Record<string, McpApprovalStatus> = {};
  let answered = true;
  try {
    ({ servers: statuses } = await deps.poster.mcpApprovals(
      approvalsRequest({ token: await deps.fetchToken(), bot: config.bot, servers }, thread),
    ));
  } catch (error) {
    answered = false;
    console.warn(
      `::warning::Could not read MCP server approvals (${(error as Error).name}); treating them as pending`,
    );
  }
  const named = (status: McpApprovalStatus) =>
    servers.filter(({ name }) => (statuses[name] ?? "pending") === status);
  const pending = named("pending");
  const denied = named("denied");
  return {
    dropped: new Set([...pending, ...denied].map(({ name }) => name)),
    notice: {
      pending: pending.map(({ name }) => ({
        name,
        tools: serverTools(name, config.allowed_tools),
      })),
      denied: denied.map(({ name }) => name),
    },
    pendingServers: answered ? pending : [],
  };
}

export const NO_DROPPED: McpApprovalOutcome = {
  dropped: new Set(),
  notice: { pending: [], denied: [] },
  pendingServers: [],
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
