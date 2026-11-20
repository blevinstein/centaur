import {
  type DetailedError,
  isAuthorized,
  policySetTextToParts,
  validate,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { ConfigIssue } from "./index.js";
import { MCP_POLICY_SCHEMA } from "./mcp-policy-schema.js";
import type { McpServer } from "./schema.js";

export interface McpPolicySources {
  global?: string | undefined;
  bot?: string | undefined;
}

const POLICY_SOURCES = ["global", "bot"] as const;
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

type PolicySet = { policies: Record<string, string> } | { errors: string[] };

function mergePolicies(sources: McpPolicySources): PolicySet {
  const policies: Record<string, string> = {};
  const errors: string[] = [];
  for (const source of POLICY_SOURCES) {
    const text = sources[source];
    if (!text) continue;
    const parts = policySetTextToParts(text);
    if (parts.type === "failure") {
      errors.push(...messagesOf(parts.errors).map((message) => `${source} policy: ${message}`));
    } else if (parts.policy_templates.length > 0) {
      errors.push(`${source} policy: templates are not supported`);
    } else {
      parts.policies.forEach((policy, index) => {
        policies[`${source}.${index}`] = policy;
      });
    }
  }
  return errors.length > 0 ? { errors } : { policies };
}

function authorize(bot: string, name: string, server: McpServer, policies: Record<string, string>) {
  const answer = isAuthorized({
    principal: { type: "Bot", id: bot },
    action: { type: "Action", id: "UseServer" },
    resource: { type: "McpServer", id: name },
    context: {},
    policies: { staticPolicies: policies },
    entities: [
      {
        uid: { type: "McpServer", id: name },
        attrs: describeServer(server),
        parents: [],
      },
    ],
  });
  if (answer.type === "failure") return `policy evaluation failed: ${messagesOf(answer.errors)}`;
  const { decision, diagnostics } = answer.response;
  if (diagnostics.errors.length > 0) {
    return `policy evaluation failed: ${diagnostics.errors.map(({ error }) => error.message)}`;
  }
  if (decision === "allow") return undefined;
  return diagnostics.reason.length > 0
    ? `forbidden by policy ${diagnostics.reason.join(", ")}`
    : "not permitted by any policy";
}

export function checkMcpPolicy(
  bot: string,
  servers: Record<string, McpServer>,
  sources: McpPolicySources,
): ConfigIssue[] {
  const merged = mergePolicies(sources);
  return Object.entries(servers).flatMap(([name, server]) => {
    const message =
      "errors" in merged
        ? `operator policy is invalid: ${merged.errors.join("; ")}`
        : authorize(bot, name, server, merged.policies);
    return message === undefined ? [] : [{ path: `mcp_servers.${name}`, message }];
  });
}

export function validateMcpPolicy(text: string): string[] {
  const merged = mergePolicies({ global: text });
  if ("errors" in merged) return merged.errors;
  const answer = validate({
    schema: MCP_POLICY_SCHEMA,
    policies: { staticPolicies: merged.policies },
  });
  return answer.type === "failure"
    ? messagesOf(answer.errors)
    : answer.validationErrors.map(({ policyId, error }) => `${policyId}: ${error.message}`);
}
