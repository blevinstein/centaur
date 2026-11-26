import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { PolicyLayers } from "../../src/config/mcp-policy.js";
import type { PolicyLintContext } from "../../src/config/mcp-policy-lint.js";
import { runCli } from "../../src/workflows/program.js";
import { writeToolPolicy } from "../../src/workflows/turn-state.js";
import { createCliHarness } from "./cli.js";
import { PERMIT_ANY_REMOTE } from "./mcp-policy-fixtures.js";
import { configText, createWorkspace } from "./workflow-fixtures.js";

const CALL_TOOL = 'action == Action::"CallTool"';

/** Refuses `delete_issue` on `linear` unless the call names one of two issues. */
export const FORBID_DELETE_UNLESS_ALLOWED_ID = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless { context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id) };`;

/** The allowlist form that also refuses a sibling parameter the tool honors. */
export const FORBID_DELETE_UNLESS_ONLY_ID = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless {
    !(context.args has ids) && context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id)
  };`;

/** Reads an argument the call may lack without guarding it with `has`. */
export const FORBID_DELETE_UNGUARDED = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.name == "delete_issue" && !(["ENG-1"].contains(context.args.id)) };`;

export const FORBID_SERVER_UNLESS_READS = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.server == "linear" }
  unless { ["get_issue", "list_issues"].contains(resource.name) };`;

export const forbidChatTool = (name?: string) =>
  `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.server == "centaur-chat"${name ? ` && resource.name == "${name}"` : ""} };`;

export const FORBID_UNSCOPED_ON_HOST = `forbid(principal, action, resource)
  when { resource.host like "*.untrusted.example" };`;

export const FORBID_ACTION_TYPO = `forbid(principal, action == Action::"CallTools", resource)
  when { resource.server == "linear" };`;

export const FORBID_ATTRIBUTE_TYPO = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.nmae == "delete_issue" };`;

export const FORBID_SIBLING_ONLY = `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.name == "delete_issue" && context.args has ids };`;

export const forbidToolLiteral = (server: string, name: string) =>
  `forbid(principal, ${CALL_TOOL}, resource)
  when { resource.server == "${server}" && resource.name == "${name}" };`;

export const FORBID_SCOPED_TOOL = `forbid(principal, ${CALL_TOOL}, resource == McpTool::"linear/delete_issue");`;

export const LINEAR_LINT_CONTEXT: PolicyLintContext = {
  servers: ["linear"],
  allowedTools: ["mcp__linear__get_issue", "mcp__linear__delete_issue"],
};

export const LINEAR_WILDCARD_LINT_CONTEXT: PolicyLintContext = {
  servers: ["linear"],
  allowedTools: ["mcp__linear__*"],
};

export const linearToolsConfig = (tools: string) =>
  configText("mcp_servers:\n  linear:\n    url: https://mcp.linear.app/mcp").replace(
    "Read,Edit",
    `Read,${tools}`,
  );

export const LINEAR_CALL = (tool: string, args: Record<string, unknown> = {}) => ({
  server: "linear",
  tool,
  args,
});

export const hookInput = (toolName: string, toolInput: unknown = {}) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput });

/** A turn state directory holding the saved policy for bot `sprout`. */
export async function toolPolicyStateDir(layers: PolicyLayers | string) {
  const stateDir = await mkdtemp(join(tmpdir(), "centaur-gate-"));
  await writeToolPolicy(stateDir, {
    bot: "sprout",
    layers: typeof layers === "string" ? { repo: layers } : layers,
  });
  return stateDir;
}

export const executionWithCalls = (calls: { name: string; input?: unknown }[]) =>
  JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "working" },
          ...calls.map((call, index) => ({
            type: "tool_use",
            id: `t${index}`,
            name: call.name,
            input: call.input ?? {},
          })),
        ],
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "result", structured_output: { reply: "done" } },
  ]);

export async function writeTempFile(name: string, text: string) {
  const dir = await mkdtemp(join(tmpdir(), "centaur-file-"));
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

/** Runs the hook's shell command with `input` on stdin, as Claude Code does. */
export function runHookCommand(command: string, input: string) {
  const { status, stdout, stderr } = spawnSync("/bin/sh", ["-c", command], {
    input,
    encoding: "utf8",
  });
  return { status, stdout, stderr };
}

export const GATE_SCRIPTS = {
  prints: 'process.stdout.write(JSON.stringify({ decision: "allow" }));',
  crashes: 'throw new Error("boom");',
  allows: "",
  denies: 'process.stderr.write("no\\n"); process.exitCode = 2;',
};

/** Runs the `tool-gate` command in process with `input` on stdin. */
export async function runToolGate(stateDir: string, input: string) {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(input)]),
    configurable: true,
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["tool-gate", "--state-dir", stateDir]);
    return {
      exitCode: process.exitCode,
      stderr: stderr.mock.calls.map(([text]) => String(text)).join(""),
      stdout: stdout.mock.calls.length,
    };
  } finally {
    process.exitCode = undefined;
    if (stdin) Object.defineProperty(process, "stdin", stdin);
    stderr.mockRestore();
    stdout.mockRestore();
  }
}

const LINEAR_TOOLS = "mcp__linear__get_issue, mcp__linear__delete_issue";

/** Runs a `centaur` command on a workspace whose config and policy file permit the linear server. */
export async function runPolicyCli(
  command: string[],
  flags: string[],
  policy: string,
  tools = LINEAR_TOOLS,
) {
  const { root } = await createWorkspace({
    ".centaur.yml": linearToolsConfig(tools),
    ".centaur/mcp-policy.cedar": `${PERMIT_ANY_REMOTE}\n${policy}`,
  });
  const cli = createCliHarness();
  await cli.run(...command, join(root, ".centaur.yml"), ...flags);
  return cli.output.join("\n");
}
