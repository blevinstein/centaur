import {
  type DetailedError,
  isAuthorized,
  policySetTextToParts,
  validate,
} from "@cedar-policy/cedar-wasm/nodejs";
import type { ConfigIssue } from "./index.js";
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

type ParsedPolicies = { policies: Record<string, string> } | { errors: string[] };

function parsePolicies(text: string): ParsedPolicies {
  const parts = policySetTextToParts(text);
  if (parts.type === "failure") return { errors: messagesOf(parts.errors) };
  if (parts.policy_templates.length > 0) return { errors: ["templates are not supported"] };
  return {
    policies: Object.fromEntries(
      parts.policies.map((policy, index) => [`policy.${index}`, policy]),
    ),
  };
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
  policyText: string,
): ConfigIssue[] {
  const parsed = parsePolicies(policyText);
  return Object.entries(servers).flatMap(([name, server]) => {
    const message =
      "errors" in parsed
        ? `operator policy is invalid: ${parsed.errors.join("; ")}`
        : authorize(bot, name, server, parsed.policies);
    return message === undefined ? [] : [{ path: `mcp_servers.${name}`, message }];
  });
}

export function validateMcpPolicy(text: string): string[] {
  const parsed = parsePolicies(text);
  if ("errors" in parsed) return parsed.errors;
  const answer = validate({
    schema: MCP_POLICY_SCHEMA,
    policies: { staticPolicies: parsed.policies },
  });
  return answer.type === "failure"
    ? messagesOf(answer.errors)
    : answer.validationErrors.map(({ policyId, error }) => `${policyId}: ${error.message}`);
}
