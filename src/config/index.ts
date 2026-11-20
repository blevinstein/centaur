import { parse } from "yaml";
import type { ZodError } from "zod";
import { type CentaurConfig, centaurConfigSchema } from "./schema.js";

export { checkMcpPolicy, type McpPolicySources, validateMcpPolicy } from "./mcp-policy.js";
export { PROVIDER_SETTINGS, PROVIDERS, type Provider } from "./providers.js";
export {
  ALIAS_PATTERN,
  alias,
  type CentaurConfig,
  type ContextPolicy,
  centaurConfigSchema,
  type McpServer,
  PLATFORMS,
  type Platform,
  type RespondTo,
  type SecretRef,
} from "./schema.js";

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; config: CentaurConfig }
  | { ok: false; issues: ConfigIssue[] };

const formatPath = (path: PropertyKey[]): string =>
  path.reduce<string>(
    (acc, key) =>
      typeof key === "number" ? `${acc}[${key}]` : acc ? `${acc}.${String(key)}` : String(key),
    "",
  ) || "(root)";

const fromZodError = (error: ZodError): ConfigIssue[] =>
  error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));

export function parseCentaurConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "(root)", message: `invalid YAML: ${(error as Error).message}` }],
    };
  }
  const result = centaurConfigSchema.safeParse(raw);
  return result.success
    ? { ok: true, config: result.data }
    : { ok: false, issues: fromZodError(result.error) };
}

export const formatIssues = (issues: ConfigIssue[]): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
