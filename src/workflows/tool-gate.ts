import { z } from "zod";
import { checkToolCall } from "../config/mcp-policy.js";
import { readToolPolicy } from "./turn-state.js";

const MCP_TOOL_PREFIX = "mcp__";

const hookInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});

/** `mcp__<server>__<tool>`; the tool part may itself contain `__`. */
function parseMcpToolName(name: string) {
  const separator = name.indexOf("__", MCP_TOOL_PREFIX.length);
  if (separator < 0) return undefined;
  const server = name.slice(MCP_TOOL_PREFIX.length, separator);
  const tool = name.slice(separator + 2);
  return server && tool ? { server, tool } : undefined;
}

async function refusal(stateDir: string, rawInput: string) {
  const input = hookInput.parse(JSON.parse(rawInput));
  if (!input.tool_name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const call = parseMcpToolName(input.tool_name);
  if (!call) return `cannot parse the MCP tool name ${input.tool_name}`;
  const { bot, layers } = await readToolPolicy(stateDir);
  return checkToolCall(bot, { ...call, args: input.tool_input }, layers);
}

/**
 * The `PreToolUse` hook for MCP tool calls. Returns the hook's JSON output when the call is
 * refused, or undefined to leave the decision to Claude Code's own permissions. Anything it cannot
 * read or evaluate refuses the call.
 */
export async function gateToolCall(stateDir: string, rawInput: string) {
  const reason = await refusal(stateDir, rawInput).catch(
    (error: Error) => `cannot check the operator policy: ${error.message}`,
  );
  if (reason === undefined) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Refused by the operator policy: ${reason}`,
    },
  };
}

/** Claude Code settings that route every MCP tool call through `tool-gate`. */
export const toolGateSettings = (cliPath: string, stateDir: string) => ({
  hooks: {
    PreToolUse: [
      {
        matcher: `${MCP_TOOL_PREFIX}.*`,
        hooks: [{ type: "command", command: `node ${cliPath} tool-gate --state-dir ${stateDir}` }],
      },
    ],
  },
});
