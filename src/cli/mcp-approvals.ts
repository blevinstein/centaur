import { z } from "zod";
import { mcpApprovalsPrefix } from "../lambda/connection-paths.js";
import type { ParameterStore } from "./parameter-store.js";

const recordSchema = z.object({ at: z.string(), approver: z.string() }).partial();

export interface McpApproval {
  parameter: string;
  name: string;
  fingerprint: string;
  at: string;
  approver: string;
}

function parseRecord(value: string) {
  try {
    return recordSchema.parse(JSON.parse(value));
  } catch {
    return {};
  }
}

/** A bot's approved MCP server definitions, ordered by name then fingerprint. */
export async function listMcpApprovals(store: ParameterStore, bot: string): Promise<McpApproval[]> {
  const prefix = mcpApprovalsPrefix(bot);
  const approvals = (await store.getByPath(prefix)).flatMap(({ name: parameter, value }) => {
    const [name, fingerprint, ...rest] = parameter.slice(prefix.length).split("/");
    if (!name || !fingerprint || rest.length > 0) return [];
    const { at, approver } = parseRecord(value);
    return [{ parameter, name, fingerprint, at: at ?? "unknown", approver: approver ?? "-" }];
  });
  return approvals.sort((a, b) => a.parameter.localeCompare(b.parameter));
}

export const formatMcpApproval = ({ name, fingerprint, at, approver }: McpApproval) =>
  [name, fingerprint, at, approver].join("  ");
