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

const PACKAGE_NAME = "(?:@[\\w.-]+/)?[A-Za-z0-9][\\w.-]*(?:\\[[\\w.,-]+\\])?";
const EXACT_VERSION = new RegExp(`^${PACKAGE_NAME}(?:@|==)\\d+\\.\\d+\\.\\d+(?:[-+][\\w.+-]+)?$`);
const PYTHON_VERSION = /^\d+(?:\.\d+){0,2}$/;
const PLAIN_COMMAND = /^[A-Za-z0-9][\w.-]*$/;
// Commands that run arbitrary code from their arguments.
const GENERIC_RUNNERS =
  /^(?:python[\d.]*|pypy[\d.]*|[a-z]*sh|env|node|nodejs|deno|bun|perl|ruby|php|lua|awk|sed|find|xargs|eval|exec|sudo|busybox|powershell|pwsh|npx|npm|pnpm|yarn|uv|uvx|pip[\d.]*|pipx|curl|wget)$/i;

const COMMIT_SHA = "[0-9a-f]{40}";
const URL_SEGMENT = "[\\w~-][\\w.~-]*";
const GIT_HTTPS_URL = `git\\+https://[\\w-]+(?:\\.[\\w-]+)*(?::\\d+)?(?:/${URL_SEGMENT})+`;
const PIP_FRAGMENT = "(?:#(?:egg|subdirectory)=[\\w-][\\w.-]*(?:/[\\w-][\\w.-]*)*)?";
const COMMIT_PINNED_GIT = new RegExp(
  `^(?:${GIT_HTTPS_URL}@${COMMIT_SHA}${PIP_FRAGMENT}|${GIT_HTTPS_URL}#${COMMIT_SHA}|github:${URL_SEGMENT}/${URL_SEGMENT}#${COMMIT_SHA})$`,
  "i",
);

const messagesOf = (errors: DetailedError[]) => errors.map((error) => error.message);

type FlagKind = "bool" | "value";
type FlagTable = Record<string, FlagKind>;

// Flags that leave the launched code fixed. Any other flag before the target (index, registry,
// config, editable, requirements and constraint flags, which can redirect or alter what is
// resolved) makes the target unknowable.
const UVX_FLAGS: FlagTable = {
  "--from": "value",
  "--with": "value",
  "--python": "value",
  "-p": "value",
  "--index-strategy": "value",
  "--resolution": "value",
  "--prerelease": "value",
  "--exclude-newer": "value",
  "--cache-dir": "value",
  "--isolated": "bool",
  "--no-cache": "bool",
  "-n": "bool",
  "--offline": "bool",
  "--quiet": "bool",
  "-q": "bool",
  "--verbose": "bool",
  "-v": "bool",
  "--native-tls": "bool",
  "--no-progress": "bool",
  "--refresh": "bool",
  "--reinstall": "bool",
  "--upgrade": "bool",
  "-U": "bool",
  "--no-config": "bool",
};

const NPX_FLAGS: FlagTable = {
  "--package": "value",
  "-p": "value",
  "--call": "value",
  "-c": "value",
  "--loglevel": "value",
  "--yes": "bool",
  "-y": "bool",
  "--no": "bool",
  "-n": "bool",
  "--no-install": "bool",
  "--ignore-existing": "bool",
  "--quiet": "bool",
  "-q": "bool",
  "--silent": "bool",
  "--offline": "bool",
  "--prefer-offline": "bool",
  "--no-audit": "bool",
  "--no-fund": "bool",
};

type ParsedLauncherArgs = { flagValues: Map<string, string[]>; positional: string | undefined };

// Arguments after the first positional belong to the launched tool. Undefined when a flag is
// unknown, lacks its value or takes one it cannot take.
function parseLauncherArgs(args: string[], flags: FlagTable): ParsedLauncherArgs | undefined {
  const flagValues = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return { flagValues, positional: args[i + 1] };
    if (!arg.startsWith("-")) return { flagValues, positional: arg };
    const [name = "", inline] = arg.split(/=(.*)/s, 2);
    const kind = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (kind === undefined || (kind === "bool" && inline !== undefined)) return undefined;
    if (kind === "value") {
      const value = inline ?? args[++i];
      if (value === undefined) return undefined;
      flagValues.set(name, [...(flagValues.get(name) ?? []), value]);
    }
  }
  return { flagValues, positional: undefined };
}

const isPinnedSpec = (spec: string | undefined) =>
  spec !== undefined && (EXACT_VERSION.test(spec) || COMMIT_PINNED_GIT.test(spec));

const flagValuesOf = (parsed: ParsedLauncherArgs, ...names: string[]) =>
  names.flatMap((name) => parsed.flagValues.get(name) ?? []);

const isLaunchedCommand = (command: string | undefined) =>
  command !== undefined && PLAIN_COMMAND.test(command) && !GENERIC_RUNNERS.test(command);

const PINNED_TARGETS: Record<string, (args: string[]) => boolean> = {
  uvx(args) {
    const parsed = parseLauncherArgs(args, UVX_FLAGS);
    if (parsed === undefined) return false;
    const froms = flagValuesOf(parsed, "--from");
    const extrasPinned = flagValuesOf(parsed, "--with").every(isPinnedSpec);
    const pythonPinned = flagValuesOf(parsed, "--python", "-p").every((v) =>
      PYTHON_VERSION.test(v),
    );
    const targetPinned =
      froms.length === 0
        ? isPinnedSpec(parsed.positional)
        : froms.length === 1 && isPinnedSpec(froms[0]) && isLaunchedCommand(parsed.positional);
    return extrasPinned && pythonPinned && targetPinned;
  },
  npx(args) {
    const parsed = parseLauncherArgs(args, NPX_FLAGS);
    if (parsed === undefined || flagValuesOf(parsed, "--call", "-c").length > 0) return false;
    const packages = flagValuesOf(parsed, "--package", "-p");
    return packages.length > 0
      ? packages.every(isPinnedSpec) && isLaunchedCommand(parsed.positional)
      : isPinnedSpec(parsed.positional);
  },
};

export const isPinned = (command: string, args: string[]) =>
  Object.hasOwn(PINNED_TARGETS, command) && (PINNED_TARGETS[command]?.(args) ?? false);

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
    pinned: isPinned(server.command, args),
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
