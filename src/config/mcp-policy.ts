import {
  type DetailedError,
  isAuthorized,
  policySetTextToParts,
  validate,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { ConfigIssue } from "./index.js";
import { mcpApprovalKey } from "./mcp-fingerprint.js";
import { MCP_POLICY_SCHEMA } from "./mcp-policy-schema.js";
import type { McpServer } from "./schema.js";

const EXACT_VERSION = /(?:@|==)\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;

const messagesOf = (errors: DetailedError[]) => errors.map((error) => error.message);

export const isPinned = (args: string[]) => {
  const target = args.find((arg) => !arg.startsWith("-"));
  return target !== undefined && EXACT_VERSION.test(target);
};

export function describeServer(server: McpServer) {
  if ("url" in server) {
    const { hostname } = new URL(server.url);
    return {
      transport: "remote",
      host: hostname,
      url: server.url,
      command: "",
      args: [],
      pinned: false,
    };
  }
  const args = server.args ?? [];
  return {
    transport: "stdio",
    host: "",
    url: "",
    command: server.command,
    args,
    pinned: isPinned(args),
  };
}

export type PolicyLayer = "global" | "repo";
export type PolicyLayers = Partial<Record<PolicyLayer, string | undefined>>;

type ParsedPolicies = { policies: Record<string, string> } | { errors: string[] };

function parsePolicies(text: string, layer: PolicyLayer = "repo"): ParsedPolicies {
  const parts = policySetTextToParts(text);
  if (parts.type === "failure") return { errors: messagesOf(parts.errors) };
  if (parts.policy_templates.length > 0) return { errors: ["templates are not supported"] };
  return {
    policies: Object.fromEntries(
      parts.policies.map((policy, index) => [`${layer}.${index}`, policy]),
    ),
  };
}

type Evaluation = { allowed: boolean; message?: string; final?: boolean };

function evaluate(
  bot: string,
  name: string,
  server: McpServer,
  policies: Record<string, string>,
  approved: boolean,
): Evaluation {
  const answer = isAuthorized({
    principal: { type: "Bot", id: bot },
    action: { type: "Action", id: "UseServer" },
    resource: { type: "McpServer", id: name },
    context: { approved },
    policies: { staticPolicies: policies },
    entities: [
      {
        uid: { type: "McpServer", id: name },
        attrs: describeServer(server),
        parents: [],
      },
    ],
  });
  if (answer.type === "failure") {
    return {
      allowed: false,
      final: true,
      message: `policy evaluation failed: ${messagesOf(answer.errors)}`,
    };
  }
  const { decision, diagnostics } = answer.response;
  if (diagnostics.errors.length > 0) {
    return {
      allowed: false,
      final: true,
      message: `policy evaluation failed: ${diagnostics.errors.map(({ error }) => error.message)}`,
    };
  }
  if (decision === "allow") return { allowed: true };
  return diagnostics.reason.length > 0
    ? {
        allowed: false,
        final: true,
        message: `forbidden by policy ${diagnostics.reason.join(", ")}`,
      }
    : { allowed: false, message: "not permitted by any policy" };
}

type Outcome =
  | { kind: "allow" }
  | { kind: "approval-required" }
  | { kind: "deny"; message: string };

/**
 * Evaluates the policy set with `approved` false, then true. A `forbid` at either evaluation denies,
 * and the true evaluation is a ceiling: a server is allowed only if it is allowed at both, and needs
 * approval when it is allowed only at true.
 */
function authorize(
  bot: string,
  name: string,
  server: McpServer,
  policies: Record<string, string>,
): Outcome {
  const [pending, approved] = [false, true].map((flag) =>
    evaluate(bot, name, server, policies, flag),
  ) as [Evaluation, Evaluation];
  const denial =
    [pending, approved].find(({ final }) => final) ?? (approved.allowed ? undefined : approved);
  if (denial) return { kind: "deny", message: denial.message ?? "not permitted by any policy" };
  return pending.allowed ? { kind: "allow" } : { kind: "approval-required" };
}

function mergePolicies(layers: PolicyLayers): ParsedPolicies {
  const policies: Record<string, string> = {};
  const errors: string[] = [];
  for (const [layer, text] of Object.entries(layers) as [PolicyLayer, string | undefined][]) {
    if (text === undefined) continue;
    const parsed = parsePolicies(text, layer);
    if ("errors" in parsed) errors.push(...parsed.errors.map((error) => `${layer}: ${error}`));
    else Object.assign(policies, parsed.policies);
  }
  return errors.length > 0 ? { errors } : { policies };
}

export interface McpApproval {
  name: string;
  /** `<name>:<fingerprint>`, from `mcpApprovalKey` */
  key: string;
}

export interface McpPolicyResult {
  issues: ConfigIssue[];
  approvals: McpApproval[];
}

/**
 * A bare string is the repo layer. Both layers form one policy set: any `forbid` wins. `allowedTools`
 * scopes each server's approval key to the entries that name it.
 */
export function evaluateMcpPolicy(
  bot: string,
  servers: Record<string, McpServer>,
  policy: string | PolicyLayers,
  allowedTools: string[] = [],
): McpPolicyResult {
  const parsed = mergePolicies(typeof policy === "string" ? { repo: policy } : policy);
  const result: McpPolicyResult = { issues: [], approvals: [] };
  for (const [name, server] of Object.entries(servers)) {
    const outcome: Outcome =
      "errors" in parsed
        ? { kind: "deny", message: `operator policy is invalid: ${parsed.errors.join("; ")}` }
        : authorize(bot, name, server, parsed.policies);
    if (outcome.kind === "deny") {
      result.issues.push({ path: `mcp_servers.${name}`, message: outcome.message });
    } else if (outcome.kind === "approval-required") {
      result.approvals.push({ name, key: mcpApprovalKey(name, server, allowedTools) });
    }
  }
  return result;
}

export const checkMcpPolicy = (...args: Parameters<typeof evaluateMcpPolicy>) =>
  evaluateMcpPolicy(...args).issues;

export const formatApprovals = (approvals: McpApproval[]) =>
  `MCP servers that need admin approval before they run: ${approvals.map(({ key }) => key).join(", ")}`;

export function validateMcpPolicy(text: string, layer: PolicyLayer = "repo"): string[] {
  const parsed = parsePolicies(text, layer);
  if ("errors" in parsed) return parsed.errors;
  const answer = validate({
    schema: MCP_POLICY_SCHEMA,
    policies: { staticPolicies: parsed.policies },
  });
  return answer.type === "failure"
    ? messagesOf(answer.errors)
    : answer.validationErrors.map(({ policyId, error }) => `${policyId}: ${error.message}`);
}
