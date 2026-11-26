import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkToolCall } from "../config/mcp-policy.js";
import { shellArg, singleQuote } from "./shell-arg.js";
import { readToolPolicy, type ToolPolicyState } from "./turn-state.js";

export const MCP_TOOL_PREFIX = "mcp__";

/** The built CLI the hook runs, next to this module in the trusted checkout's `dist/`. */
const GATE_ENTRY = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Claude Code's hook timeouts are seconds. */
const HOOK_TIMEOUT_SECONDS = 15;

const hookInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});

/** `mcp__<server>__<tool>`; server names hold no `__`, but a tool name may. */
function parseMcpToolName(name: string) {
  const separator = name.indexOf("__", MCP_TOOL_PREFIX.length);
  const server = name.slice(MCP_TOOL_PREFIX.length, separator);
  const tool = name.slice(separator + 2);
  return separator < 0 || !server || !tool ? undefined : { server, tool };
}

/** The reason the policy refuses a call to `toolName`, or undefined. Tools outside MCP are not checked. */
export function refusalFor(
  policy: ToolPolicyState,
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const call = parseMcpToolName(toolName);
  if (!call) return `cannot parse the MCP tool name ${toolName}`;
  return checkToolCall(policy.bot, { ...call, args }, policy.layers);
}

/**
 * Evaluates one `PreToolUse` hook input (the JSON Claude Code writes to stdin). Returns the
 * reason to refuse the call, or undefined to leave the decision to `allowed_tools`. Anything it
 * cannot read or evaluate is a refusal.
 */
export async function gateToolCall(stateDir: string, rawInput: string) {
  try {
    const input = hookInput.parse(JSON.parse(rawInput));
    return refusalFor(await readToolPolicy(stateDir), input.tool_name, input.tool_input);
  } catch (error) {
    return `cannot check the operator policy: ${(error as Error).message}`;
  }
}

/**
 * A shell wrapper around `tool-gate` for the hook command. Claude Code lets a call proceed when a
 * hook exits with any code but 2 or prints stray output before a JSON decision, so the wrapper maps
 * every failure (missing script, crash, stray output) to exit 2. An allow is exit 0 with nothing
 * on stdout, and the reason for a deny is on stderr.
 */
export function gateCommand(entry: string, stateDir: string) {
  const run = `${shellArg(process.execPath)} ${shellArg(entry)} tool-gate --state-dir ${shellArg(stateDir)}`;
  const script = `out=$(${run}) || exit 2; [ -z "$out" ] || { echo "tool-gate printed unexpected output" >&2; exit 2; }`;
  return `sh -c ${singleQuote(script)}`;
}

/**
 * The Claude Code settings `prepare` passes with `--settings`: every MCP tool call goes through the
 * gate. `onFailure: "block"` makes a missing script, a crash and a timeout block the call, where
 * Claude Code would otherwise let it proceed; the wrapper in `gateCommand` backs it up.
 */
export const toolGateSettings = (stateDir: string, entry = GATE_ENTRY) => ({
  hooks: {
    PreToolUse: [
      {
        matcher: `${MCP_TOOL_PREFIX}.*`,
        hooks: [
          {
            type: "command",
            command: gateCommand(entry, stateDir),
            timeout: HOOK_TIMEOUT_SECONDS,
            onFailure: "block",
          },
        ],
      },
    ],
  },
});
