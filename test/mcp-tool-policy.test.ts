import { describe, expect, it } from "vitest";
import { checkToolCall, validateMcpPolicy } from "../src/config/mcp-policy.js";
import { lintToolPolicy, policyProblems } from "../src/config/mcp-policy-lint.js";
import { FORBID_UNLESS_GITHUB, PERMIT_GITHUB } from "./helpers/mcp-policy-fixtures.js";
import {
  FORBID_ACTION_TYPO,
  FORBID_ATTRIBUTE_TYPO,
  FORBID_DELETE_UNGUARDED,
  FORBID_DELETE_UNLESS_ALLOWED_ID,
  FORBID_DELETE_UNLESS_ONLY_ID,
  FORBID_SCOPED_TOOL,
  FORBID_SERVER_UNLESS_READS,
  FORBID_SIBLING_ONLY,
  FORBID_UNSCOPED_ON_HOST,
  forbidToolLiteral,
  LINEAR_CALL,
  LINEAR_LINT_CONTEXT,
  LINEAR_WILDCARD_LINT_CONTEXT,
} from "./helpers/tool-policy-fixtures.js";

describe("validating CallTool policies", () => {
  it.each([
    FORBID_DELETE_UNLESS_ALLOWED_ID,
    FORBID_DELETE_UNLESS_ONLY_ID,
    FORBID_SERVER_UNLESS_READS,
    FORBID_SCOPED_TOOL,
  ])("accepts %s", (policy) => {
    expect(validateMcpPolicy(policy)).toEqual([]);
  });

  it.each<[string, string, RegExp]>([
    ["an action typo", FORBID_ACTION_TYPO, /unrecognized action/],
    ["an attribute typo", FORBID_ATTRIBUTE_TYPO, /nmae/],
    ["an unscoped forbid on server attributes", FORBID_UNSCOPED_ON_HOST, /attribute `host`/],
    ["an argument read without has", FORBID_DELETE_UNGUARDED, /args\.id/],
    ["a sibling check outside the allowlist form", FORBID_SIBLING_ONLY, /impossible/],
  ])("rejects %s", (_name, policy, message) => {
    expect(validateMcpPolicy(policy).join("\n")).toMatch(message);
  });

  it("reports a warning as a problem of its layer", () => {
    const { errors } = policyProblems({ repo: FORBID_SIBLING_ONLY }, LINEAR_LINT_CONTEXT);

    expect(errors).toEqual([{ layer: "repo", message: expect.stringMatching(/impossible/) }]);
  });
});

describe("linting policy literals", () => {
  it.each<[string, string]>([
    ["a server in a different case", forbidToolLiteral("Linear", "delete_issue")],
    ["a server that is not configured", forbidToolLiteral("jira", "delete_issue")],
  ])("flags %s", (_name, policy) => {
    expect(lintToolPolicy(policy, LINEAR_LINT_CONTEXT).errors).toEqual([
      expect.stringMatching(/server ".*" is not in mcp_servers/),
    ]);
  });

  it.each<[string, string]>([
    ["a misspelled tool", forbidToolLiteral("linear", "delete_issues")],
    ["a tool in a different case", forbidToolLiteral("linear", "Delete_Issue")],
  ])("flags %s", (_name, policy) => {
    expect(lintToolPolicy(policy, LINEAR_LINT_CONTEXT).errors).toEqual([
      expect.stringMatching(/tool ".*" is not in allowed_tools/),
    ]);
  });

  it("flags a tool literal in the allowlist set", () => {
    const { errors } = lintToolPolicy(FORBID_SERVER_UNLESS_READS, LINEAR_LINT_CONTEXT);

    expect(errors).toEqual([expect.stringMatching(/tool "list_issues" is not in allowed_tools/)]);
  });

  it("accepts the names that match servers and allowed_tools", () => {
    for (const policy of [
      FORBID_DELETE_UNLESS_ALLOWED_ID,
      FORBID_SCOPED_TOOL,
      forbidToolLiteral("linear", "get_issue"),
    ]) {
      expect(lintToolPolicy(policy, LINEAR_LINT_CONTEXT)).toEqual({ errors: [], warnings: [] });
    }
  });

  it("flags a name in a policy scope", () => {
    const policy = FORBID_SCOPED_TOOL.replace("linear/delete_issue", "linear/delete_issues");

    expect(lintToolPolicy(policy, LINEAR_LINT_CONTEXT).errors).toHaveLength(1);
  });

  it("warns, without failing, when a wildcard allowed_tools entry covers the tool", () => {
    expect(lintToolPolicy(FORBID_DELETE_UNLESS_ALLOWED_ID, LINEAR_WILDCARD_LINT_CONTEXT)).toEqual({
      errors: [],
      warnings: [expect.stringMatching(/tool "delete_issue" is allowed only by a wildcard/)],
    });
  });

  it("does not lint the global layer, which names servers other repos use", () => {
    const layers = { global: forbidToolLiteral("jira", "delete_issue") };

    expect(policyProblems(layers, LINEAR_LINT_CONTEXT)).toEqual({ errors: [], warnings: [] });
  });

  it("ignores policies that name no server or tool", () => {
    expect(lintToolPolicy(PERMIT_GITHUB, LINEAR_LINT_CONTEXT)).toEqual({
      errors: [],
      warnings: [],
    });
    expect(lintToolPolicy(FORBID_UNLESS_GITHUB, LINEAR_LINT_CONTEXT)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

describe("checkToolCall", () => {
  const call = (policy: string, tool: string, args: Record<string, unknown> = {}) =>
    checkToolCall("sprout", LINEAR_CALL(tool, args), policy);

  it("permits every call when no policy names CallTool", () => {
    expect(call(PERMIT_GITHUB, "delete_issue", { id: "ENG-9" })).toBeUndefined();
    expect(call("", "delete_issue")).toBeUndefined();
  });

  it("is not restricted by a server-level forbid", () => {
    expect(call(FORBID_UNLESS_GITHUB, "delete_issue")).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ["an allowed id", { id: "ENG-1" }, true],
    ["another allowed id", { id: "ENG-2" }, true],
    ["a refused id", { id: "ENG-9" }, false],
    ["no id", {}, false],
    ["an id of another type", { id: 1 }, false],
    ["a null id", { id: null }, false],
  ])("the allowlist form with %s", (_name, args, allowed) => {
    const refusal = call(FORBID_DELETE_UNLESS_ALLOWED_ID, "delete_issue", args);

    expect(refusal === undefined).toBe(allowed);
    if (!allowed) expect(refusal).toBe("forbidden by policy repo.0");
  });

  it("leaves other tools and servers alone", () => {
    expect(call(FORBID_DELETE_UNLESS_ALLOWED_ID, "get_issue")).toBeUndefined();
    expect(
      checkToolCall(
        "sprout",
        { server: "jira", tool: "delete_issue", args: {} },
        FORBID_DELETE_UNLESS_ALLOWED_ID,
      ),
    ).toBeUndefined();
  });

  it("refuses a call that also sends the sibling parameter", () => {
    expect(call(FORBID_DELETE_UNLESS_ONLY_ID, "delete_issue", { id: "ENG-1" })).toBeUndefined();
    expect(call(FORBID_DELETE_UNLESS_ONLY_ID, "delete_issue", { id: "ENG-1", ids: [] })).toMatch(
      /forbidden by policy/,
    );
  });

  it("refuses a tool the server-wide allowlist does not name", () => {
    expect(call(FORBID_SERVER_UNLESS_READS, "get_issue")).toBeUndefined();
    expect(call(FORBID_SERVER_UNLESS_READS, "create_issue")).toMatch(/forbidden by policy/);
  });

  it("refuses when a policy errors on a missing argument", () => {
    expect(call(FORBID_DELETE_UNGUARDED, "delete_issue", {})).toMatch(/policy evaluation failed/);
    expect(call(FORBID_DELETE_UNGUARDED, "delete_issue", { id: "ENG-2" })).toMatch(
      /forbidden by policy/,
    );
  });

  it("evaluates null, fractional and nested arguments without failing", () => {
    const args = { id: "ENG-1", note: null, score: 1.5, nested: { depth: [1, null, { x: 0.25 }] } };

    expect(call(FORBID_DELETE_UNLESS_ALLOWED_ID, "delete_issue", args)).toBeUndefined();
  });

  it("applies a forbid from either layer", () => {
    const layers = { global: FORBID_DELETE_UNLESS_ALLOWED_ID, repo: "" };

    expect(checkToolCall("sprout", LINEAR_CALL("delete_issue"), layers)).toBe(
      "forbidden by policy global.0",
    );
  });

  it("refuses when a layer does not parse", () => {
    expect(call("forbid(", "get_issue")).toMatch(/^operator policy is invalid: repo: /);
  });
});
