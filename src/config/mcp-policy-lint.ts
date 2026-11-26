import { policySetTextToParts, policyToJson } from "@cedar-policy/cedar-wasm/nodejs";
import { type PolicyLayer, type PolicyLayers, validateMcpPolicy } from "./mcp-policy.js";

export interface PolicyProblem {
  layer: PolicyLayer;
  message: string;
}

export interface PolicyLintContext {
  /** Every server a tool call can come from: `mcp_servers` and the chat server when it is on. */
  servers: string[];
  allowedTools: string[];
}

type Json = unknown;
type Literals = { servers: Set<string>; tools: Set<string> };

const isRecord = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const resourceAttribute = (node: Json): string | undefined => {
  const access = isRecord(node) ? node["."] : undefined;
  if (!isRecord(access)) return undefined;
  const { left, attr } = access;
  return isRecord(left) && left.Var === "resource" && typeof attr === "string" ? attr : undefined;
};

function literalStrings(node: Json): string[] {
  if (!isRecord(node)) return [];
  if (typeof node.Value === "string") return [node.Value];
  return Array.isArray(node.Set) ? node.Set.flatMap(literalStrings) : [];
}

function collect(node: Json, found: Literals) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return;
  }
  if (!isRecord(node)) return;
  for (const [operator, body] of Object.entries(node)) {
    if (["==", "!=", "contains"].includes(operator) && isRecord(body)) {
      for (const [attribute, other] of [
        [body.left, body.right],
        [body.right, body.left],
      ] as const) {
        const target = resourceAttribute(attribute);
        if (target === "server" || target === "name") {
          for (const literal of literalStrings(other)) {
            found[target === "server" ? "servers" : "tools"].add(literal);
          }
        }
      }
    }
    collect(body, found);
  }
}

function literalsOf(policy: Json): Literals {
  const found: Literals = { servers: new Set(), tools: new Set() };
  if (!isRecord(policy)) return found;
  const resource = policy.resource;
  if (isRecord(resource) && resource.op === "==" && isRecord(resource.entity)) {
    const { type, id } = resource.entity;
    if (type === "McpTool" && typeof id === "string") {
      const [server = "", ...tool] = id.split("/");
      found.servers.add(server);
      found.tools.add(tool.join("/"));
    }
  }
  collect(policy.conditions, found);
  return found;
}

const wildcardCovers = (allowedTools: string[], server: string) =>
  allowedTools.some((tool) => tool === `mcp__${server}` || tool === `mcp__${server}__*`);

/**
 * Compares the server and tool names a policy's conditions mention with `mcp_servers` and
 * `allowed_tools`. A name that matches neither never matches a call, so a `forbid` on it restricts
 * nothing. A tool covered only by a wildcard entry is a warning: the server may add tools later.
 */
export function lintToolPolicy(text: string, context: PolicyLintContext) {
  const problems = { errors: [] as string[], warnings: [] as string[] };
  const parts = policySetTextToParts(text);
  if (parts.type === "failure") return problems;
  parts.policies.forEach((source, index) => {
    const parsed = policyToJson(source);
    if (parsed.type === "failure") return;
    const id = `repo.${index}`;
    const { servers, tools } = literalsOf(parsed.json);
    const known = context.servers.filter((name) => servers.has(name));
    for (const server of servers) {
      if (!context.servers.includes(server)) {
        problems.errors.push(`${id}: server "${server}" is not in mcp_servers`);
      }
    }
    if (servers.size > 0 && known.length === 0) return;
    const candidates = servers.size > 0 ? known : context.servers;
    for (const tool of tools) {
      if (candidates.some((server) => context.allowedTools.includes(`mcp__${server}__${tool}`))) {
        continue;
      }
      const wildcard = candidates.some((server) => wildcardCovers(context.allowedTools, server));
      (wildcard ? problems.warnings : problems.errors).push(
        wildcard
          ? `${id}: tool "${tool}" is allowed only by a wildcard allowed_tools entry`
          : `${id}: tool "${tool}" is not in allowed_tools`,
      );
    }
  });
  return problems;
}

/**
 * Everything wrong with the policy layers: validation errors and warnings in either layer, which
 * fail alike, and the literal lint of the repo layer. The global layer names servers a given repo
 * may not use, so it is not linted.
 */
export function policyProblems(layers: PolicyLayers, context: PolicyLintContext) {
  const errors: PolicyProblem[] = [];
  const warnings: PolicyProblem[] = [];
  for (const layer of ["global", "repo"] as const) {
    const text = layers[layer];
    if (text === undefined) continue;
    errors.push(...validateMcpPolicy(text, layer).map((message) => ({ layer, message })));
  }
  if (layers.repo !== undefined) {
    const lint = lintToolPolicy(layers.repo, context);
    errors.push(...lint.errors.map((message) => ({ layer: "repo" as const, message })));
    warnings.push(...lint.warnings.map((message) => ({ layer: "repo" as const, message })));
  }
  return { errors, warnings };
}
