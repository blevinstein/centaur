import type { McpServer, SecretRef } from "../config/index.js";

export interface McpConfig {
  mcpServers: Record<string, Record<string, unknown>>;
}

export interface BuiltMcpConfig {
  config: McpConfig;
  missingSecrets: string[];
}

/**
 * Maps `mcp_servers` to Claude Code's `--mcp-config` JSON. Secrets are written as `${NAME}`
 * references so the file holds no values; `missingSecrets` lists each referenced name that is unset
 * or empty in `env`.
 */
export function buildMcpConfig(
  servers: Record<string, McpServer>,
  env: Record<string, string | undefined>,
): BuiltMcpConfig {
  const missing = new Set<string>();

  const render = (value: string | SecretRef): string => {
    if (typeof value === "string") return value;
    if (!env[value.secret]) missing.add(value.secret);
    return `${value.prefix ?? ""}\${${value.secret}}`;
  };

  const renderAll = (values: Record<string, string | SecretRef>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, render(value)]));

  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      "url" in server
        ? {
            type: "http",
            url: server.url,
            ...(server.headers && { headers: renderAll(server.headers) }),
          }
        : {
            type: "stdio",
            command: server.command,
            ...(server.args && { args: server.args }),
            ...(server.env && { env: renderAll(server.env) }),
          },
    ]),
  );

  return { config: { mcpServers }, missingSecrets: [...missing] };
}
