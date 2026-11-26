import { describe, expect, it } from "vitest";
import {
  FORBID_ACTION_TYPO,
  FORBID_DELETE_UNLESS_ALLOWED_ID,
  FORBID_SIBLING_ONLY,
  forbidToolLiteral,
  runPolicyCli,
} from "./helpers/tool-policy-fixtures.js";

const checkCall = (policy: string, tool: string, args = "{}") =>
  runPolicyCli(
    ["policy", "check-call"],
    ["--server", "linear", "--tool", tool, "--args", args],
    policy,
  );

const configCheck = (policy: string, tools?: string) =>
  runPolicyCli(["config", "check"], [], policy, tools);

describe("policy check-call", () => {
  it("prints allowed for a call the policy leaves alone", async () => {
    expect(await checkCall(FORBID_DELETE_UNLESS_ALLOWED_ID, "delete_issue", '{"id":"ENG-1"}')).toBe(
      "allowed",
    );
    expect(await checkCall(FORBID_DELETE_UNLESS_ALLOWED_ID, "get_issue")).toBe("allowed");
  });

  it("prints the refusal and the policy that caused it", async () => {
    expect(await checkCall(FORBID_DELETE_UNLESS_ALLOWED_ID, "delete_issue", '{"id":"ENG-9"}')).toBe(
      "refused: forbidden by policy repo.1",
    );
  });

  it.each(["not json", "[]", '"text"'])("rejects --args %s", async (args) => {
    await expect(checkCall("", "delete_issue", args)).rejects.toThrow(
      /--args must be a JSON object/,
    );
  });

  it("requires the server and the tool", async () => {
    await expect(
      runPolicyCli(["policy", "check-call"], ["--tool", "get_issue"], ""),
    ).rejects.toThrow(/--server/);
  });
});

describe("config check of a tool-call policy", () => {
  it("accepts a valid policy", async () => {
    expect(await configCheck(FORBID_DELETE_UNLESS_ALLOWED_ID)).toMatch(/is valid/);
  });

  it.each<[string, string, RegExp]>([
    ["an action typo", FORBID_ACTION_TYPO, /mcp-policy\.cedar: .*CallTools/],
    ["an impossible policy", FORBID_SIBLING_ONLY, /mcp-policy\.cedar: .*impossible/],
    [
      "a tool allowed_tools lacks",
      forbidToolLiteral("linear", "delete_issues"),
      /tool "delete_issues" is not in allowed_tools/,
    ],
    [
      "an unknown server literal",
      forbidToolLiteral("Linear", "delete_issue"),
      /server "Linear" is not in mcp_servers/,
    ],
  ])("fails on %s", async (_name, policy, message) => {
    await expect(configCheck(policy)).rejects.toThrow(message);
  });

  it("warns when a wildcard covers a named tool", async () => {
    expect(await configCheck(FORBID_DELETE_UNLESS_ALLOWED_ID, "mcp__linear__*")).toMatch(
      /Warning: .*wildcard/,
    );
  });
});
