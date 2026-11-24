import { createHash } from "node:crypto";
import { type McpServer, mcpToolMatchesServer } from "./schema.js";

const FINGERPRINT_LENGTH = 16;

const sortKeys = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

/**
 * The key an approval is stored under: `<name>:<fingerprint>`. The fingerprint hashes everything that
 * decides what the server runs and can reach: transport, url, command, args, the plain values and
 * secret references (never secret values) of env and headers, and the `allowed_tools` entries that
 * name the server.
 */
export function mcpApprovalKey(name: string, server: McpServer, allowedTools: string[]): string {
  const canonical = JSON.stringify(
    {
      transport: "url" in server ? "remote" : "stdio",
      url: "url" in server ? server.url : null,
      command: "command" in server ? server.command : null,
      args: "args" in server ? (server.args ?? []) : [],
      env: "env" in server ? (server.env ?? {}) : {},
      headers: "headers" in server ? (server.headers ?? {}) : {},
      allowed_tools: allowedTools.filter((tool) => mcpToolMatchesServer(tool, name)).sort(),
    },
    sortKeys,
  );
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  return `${name}:${fingerprint.slice(0, FINGERPRINT_LENGTH)}`;
}
