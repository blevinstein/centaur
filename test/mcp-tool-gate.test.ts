import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolCall, validateMcpPolicy } from "../src/config/mcp-policy.js";
import { gateToolCall, toolGateSettings } from "../src/workflows/tool-gate.js";
import { writeToolPolicy } from "../src/workflows/turn-state.js";
import {
  FORBID_DELETE_UNGUARDED,
  FORBID_DELETE_UNLESS_ALLOWED_ID,
  FORBID_UNLESS_GITHUB,
  FORBID_UNTRUSTED,
  PERMIT_GITHUB,
} from "./helpers/mcp-policy-fixtures.js";

const call = (tool: string, args: Record<string, unknown> = {}, server = "linear") => ({
  server,
  tool,
  args,
});

describe("checkToolCall", () => {
  it("permits calls no forbid matches", () => {
    expect(checkToolCall("sprout", call("list_issues"), FORBID_DELETE_UNLESS_ALLOWED_ID)).toBe(
      undefined,
    );
  });

  it("permits a guarded tool for an allowed argument", () => {
    expect(
      checkToolCall(
        "sprout",
        call("delete_issue", { id: "ENG-2" }),
        FORBID_DELETE_UNLESS_ALLOWED_ID,
      ),
    ).toBe(undefined);
  });

  it.each([
    ["another argument value", { id: "ENG-9" }],
    ["a missing argument", {}],
    ["an argument of another type", { id: 1 }],
  ])("refuses a guarded tool with %s", (_name, args) => {
    expect(
      checkToolCall("sprout", call("delete_issue", args), FORBID_DELETE_UNLESS_ALLOWED_ID),
    ).toMatch(/forbidden by policy repo\.0/);
  });

  it("does not apply a server-specific forbid to another server", () => {
    expect(
      checkToolCall("sprout", call("delete_issue", {}, "other"), FORBID_DELETE_UNLESS_ALLOWED_ID),
    ).toBe(undefined);
  });

  it("refuses when a forbid errors on an argument the call lacks", () => {
    expect(checkToolCall("sprout", call("delete_issue"), FORBID_DELETE_UNGUARDED)).toMatch(
      /policy evaluation failed/,
    );
  });

  it("accepts null and fractional arguments the policy does not read", () => {
    const args = { id: "ENG-1", note: null, score: 1.5, nested: { list: [1, null, 2.5] } };
    expect(
      checkToolCall("sprout", call("delete_issue", args), FORBID_DELETE_UNLESS_ALLOWED_ID),
    ).toBe(undefined);
  });

  it("applies forbids from any layer", () => {
    expect(
      checkToolCall("sprout", call("delete_issue", { id: "ENG-9" }), {
        global: FORBID_DELETE_UNLESS_ALLOWED_ID,
        repo: PERMIT_GITHUB,
      }),
    ).toMatch(/forbidden by policy global\.0/);
  });

  it("ignores policies that do not name CallTool", () => {
    expect(
      checkToolCall("sprout", call("list_issues"), {
        global: FORBID_UNTRUSTED,
        repo: FORBID_UNLESS_GITHUB,
      }),
    ).toBe(undefined);
  });

  it("refuses everything when a layer is invalid", () => {
    expect(checkToolCall("sprout", call("list_issues"), "not cedar")).toMatch(
      /operator policy is invalid/,
    );
  });
});

describe("validateMcpPolicy with tool-call policies", () => {
  it("accepts a CallTool policy that reads arguments", () => {
    expect(validateMcpPolicy(FORBID_DELETE_UNLESS_ALLOWED_ID)).toEqual([]);
  });
});

describe("gateToolCall", () => {
  const setup = async (policy: string | false = FORBID_DELETE_UNLESS_ALLOWED_ID) => {
    const stateDir = await mkdtemp(join(tmpdir(), "tool-gate-"));
    if (policy !== false)
      await writeToolPolicy(stateDir, { bot: "sprout", layers: { repo: policy } });
    return stateDir;
  };
  const hook = (tool_name: string, tool_input: object = {}) =>
    JSON.stringify({ tool_name, tool_input });
  const reasonOf = (output: Awaited<ReturnType<typeof gateToolCall>>) => output?.hookSpecificOutput;

  it("lets non-MCP tools through", async () => {
    expect(await gateToolCall(await setup(), hook("Bash", { command: "ls" }))).toBeUndefined();
  });

  it("lets an allowed MCP call through to Claude Code's own permissions", async () => {
    const stateDir = await setup();
    expect(
      await gateToolCall(stateDir, hook("mcp__linear__delete_issue", { id: "ENG-1" })),
    ).toBeUndefined();
  });

  it("denies a forbidden MCP call with the reason", async () => {
    const output = await gateToolCall(
      await setup(),
      hook("mcp__linear__delete_issue", { id: "ENG-9" }),
    );
    expect(reasonOf(output)).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(reasonOf(output)?.permissionDecisionReason).toMatch(/Refused by the operator policy/);
  });

  it("splits only at the first separator after the server name", async () => {
    const stateDir = await setup(
      `forbid(principal, action == Action::"CallTool", resource) when { resource.name == "a__b" };`,
    );
    expect(
      reasonOf(await gateToolCall(stateDir, hook("mcp__linear__a__b")))?.permissionDecision,
    ).toBe("deny");
  });

  it.each([
    ["malformed JSON", "{"],
    ["no tool name", "{}"],
    ["an unparseable MCP name", JSON.stringify({ tool_name: "mcp__linear" })],
  ])("denies %s", async (_name, input) => {
    expect(reasonOf(await gateToolCall(await setup(), input))?.permissionDecision).toBe("deny");
  });

  it("denies an MCP call when the policy file is missing", async () => {
    const output = await gateToolCall(await setup(false), hook("mcp__linear__list_issues"));
    expect(reasonOf(output)?.permissionDecisionReason).toMatch(/cannot check the operator policy/);
  });
});

describe("toolGateSettings", () => {
  it("runs tool-gate on every MCP tool call", () => {
    expect(toolGateSettings("/app/cli.js", "/tmp/state").hooks.PreToolUse).toEqual([
      {
        matcher: "mcp__.*",
        hooks: [{ type: "command", command: "node /app/cli.js tool-gate --state-dir /tmp/state" }],
      },
    ]);
  });
});
