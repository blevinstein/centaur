import { fileURLToPath } from "node:url";
import type { ChatToolsConfig, McpServer, SecretRef } from "../config/index.js";
import { CHAT_SERVER_ENV } from "../mcp/server-config.js";

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

/** The built entry of the chat server, resolved next to this module in the trusted checkout's `dist/`. */
export const CHAT_SERVER_ENTRY = fileURLToPath(
  new URL("../mcp/chat-server-main.js", import.meta.url),
);

/** Passed to the chat server as `${NAME}` references so the file holds no values. */
const CHAT_SERVER_FORWARDED_ENV = [
  "PATH",
  "HOME",
  "CENTAUR_FUNCTION_NAME",
  "CENTAUR_OIDC_AUDIENCE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

export function buildChatServerConfig(input: {
  env: Record<string, string | undefined>;
  stateDir: string;
  chatTools: ChatToolsConfig;
}) {
  const { env, stateDir, chatTools } = input;
  return {
    type: "stdio",
    command: "node",
    args: [CHAT_SERVER_ENTRY],
    env: {
      ...Object.fromEntries(
        CHAT_SERVER_FORWARDED_ENV.filter((name) => env[name]).map((name) => [name, `\${${name}}`]),
      ),
      [CHAT_SERVER_ENV.stateDir]: stateDir,
      [CHAT_SERVER_ENV.maxThreads]: String(chatTools.max_threads),
      [CHAT_SERVER_ENV.maxMessages]: String(chatTools.max_messages),
    },
  };
}
