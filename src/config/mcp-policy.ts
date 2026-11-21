import {
  type CedarValueJson,
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

type AuthorizationRequest = Pick<
  Parameters<typeof isAuthorized>[0],
  "action" | "resource" | "context" | "entities"
>;

function authorizeRequest(
  bot: string,
  request: AuthorizationRequest,
  policies: Record<string, string>,
) {
  const answer = isAuthorized({
    ...request,
    principal: { type: "Bot", id: bot },
    policies: { staticPolicies: policies },
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

function authorize(bot: string, name: string, server: McpServer, policies: Record<string, string>) {
  const uid = { type: "McpServer", id: name };
  return authorizeRequest(
    bot,
    {
      action: { type: "Action", id: "UseServer" },
      resource: uid,
      context: {},
      entities: [{ uid, attrs: describeServer(server), parents: [] }],
    },
    policies,
  );
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

/** A bare string is the repo layer. Both layers form one policy set: any `forbid` wins. */
export function checkMcpPolicy(
  bot: string,
  servers: Record<string, McpServer>,
  policy: string | PolicyLayers,
): ConfigIssue[] {
  const parsed = mergePolicies(typeof policy === "string" ? { repo: policy } : policy);
  return Object.entries(servers).flatMap(([name, server]) => {
    const message =
      "errors" in parsed
        ? `operator policy is invalid: ${parsed.errors.join("; ")}`
        : authorize(bot, name, server, parsed.policies);
    return message === undefined ? [] : [{ path: `mcp_servers.${name}`, message }];
  });
}

/** Every tool call is permitted unless a `forbid` on `CallTool` matches. */
const CALL_TOOL_BASELINE = 'permit(principal, action == Action::"CallTool", resource);';
const CALL_TOOL_POLICY = /Action::"CallTool"/;

const onlyCallToolPolicies = (policies: Record<string, string>) =>
  Object.fromEntries(Object.entries(policies).filter(([, text]) => CALL_TOOL_POLICY.test(text)));

export interface ToolCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Cedar contexts take no `null` and no non-integer numbers, so those are dropped or stringified. */
function toCedarValue(value: unknown): CedarValueJson {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(toCedarValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, toCedarValue(item)]),
    );
  }
  return (
    typeof value === "number" && !Number.isInteger(value) ? String(value) : value
  ) as CedarValueJson;
}

/**
 * Checks one tool call against the merged layers. The resource is `McpTool::"<server>/<tool>"`
 * with `server` and `name` attributes, and `context.args` holds the call's arguments. Returns the
 * reason a call is refused, or undefined when it may proceed. A `forbid` that errors, say on an
 * argument the call lacks and the policy did not guard with `has`, refuses the call. Only policies
 * that name `CallTool` apply, so server-level policies never affect tool calls.
 */
export function checkToolCall(
  bot: string,
  call: ToolCall,
  policy: string | PolicyLayers,
): string | undefined {
  const parsed = mergePolicies(typeof policy === "string" ? { repo: policy } : policy);
  if ("errors" in parsed) return `operator policy is invalid: ${parsed.errors.join("; ")}`;
  const uid = { type: "McpTool", id: `${call.server}/${call.tool}` };
  return authorizeRequest(
    bot,
    {
      action: { type: "Action", id: "CallTool" },
      resource: uid,
      context: { args: toCedarValue(call.args) },
      entities: [{ uid, attrs: { server: call.server, name: call.tool }, parents: [] }],
    },
    { ...onlyCallToolPolicies(parsed.policies), baseline: CALL_TOOL_BASELINE },
  );
}

/** `CallTool` policies read open-ended `context.args`, which the schema cannot type; they are only parsed. */
export function validateMcpPolicy(text: string, layer: PolicyLayer = "repo"): string[] {
  const parsed = parsePolicies(text, layer);
  if ("errors" in parsed) return parsed.errors;
  const answer = validate({
    schema: MCP_POLICY_SCHEMA,
    policies: {
      staticPolicies: Object.fromEntries(
        Object.entries(parsed.policies).filter(([, policy]) => !CALL_TOOL_POLICY.test(policy)),
      ),
    },
  });
  return answer.type === "failure"
    ? messagesOf(answer.errors)
    : answer.validationErrors.map(({ policyId, error }) => `${policyId}: ${error.message}`);
}
