import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfigOrThrow } from "../src/workflows/config-file.js";
import { checkRepositoryMcpPolicy } from "../src/workflows/mcp-policy-check.js";
import { prepare } from "../src/workflows/prepare.js";
import { auditToolCalls } from "../src/workflows/tool-audit.js";
import { hookSettingsPath, readToolPolicy } from "../src/workflows/turn-state.js";
import { APPROVAL_ENV, linearConfig } from "./helpers/mcp-approval-turn-fixtures.js";
import { fakePolicyGitHub, PERMIT_ANY_REMOTE } from "./helpers/mcp-policy-fixtures.js";
import {
  executionWithCalls,
  FORBID_ACTION_TYPO,
  FORBID_DELETE_UNLESS_ALLOWED_ID,
  FORBID_SIBLING_ONLY,
  forbidToolLiteral,
  linearToolsConfig,
  writeTempFile,
} from "./helpers/tool-policy-fixtures.js";
import { scheduledSetup, setup } from "./helpers/turn-fixtures.js";
import { message } from "./helpers/workflow-fixtures.js";

const hi = [message("1", "hi")];
const withPolicy = (...policies: string[]) =>
  fakePolicyGitHub({ policy: [PERMIT_ANY_REMOTE, ...policies].join("\n") }).deps;

const prepared = async (config: string, ...policies: string[]) => {
  const run = await setup(hi, config);
  const out = await prepare(run.deps({ env: APPROVAL_ENV, mcpPolicy: withPolicy(...policies) }));
  return { run, out };
};

describe("prepare with a tool-call policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves the layers and passes the gate's settings to the agent", async () => {
    const { run, out } = await prepared(linearConfig(), FORBID_DELETE_UNLESS_ALLOWED_ID);

    expect(out.claude_args).toContain(`--settings ${hookSettingsPath(run.stateDir)}`);
    const policy = await readToolPolicy(run.stateDir);
    expect(policy.bot).toBe("sprout");
    expect(policy.layers.repo).toContain(FORBID_DELETE_UNLESS_ALLOWED_ID);
    const settings = JSON.parse(await readFile(hookSettingsPath(run.stateDir), "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("mcp__.*");
  });

  it("loads only the user setting sources, so the agent cannot write settings that disable the gate", async () => {
    const { out } = await prepared(linearConfig(), FORBID_DELETE_UNLESS_ALLOWED_ID);

    expect(out.claude_args).toMatch(/--setting-sources user(?= |$)/);
  });

  it("restricts the setting sources for a scheduled turn with servers too", async () => {
    const run = await scheduledSetup(
      [],
      linearConfig("prompts: {weekly: {destination: household}}"),
    );

    const out = await prepare(
      run.deps({
        promptName: "weekly",
        clientPayload: undefined,
        env: APPROVAL_ENV,
        mcpPolicy: withPolicy(),
      }),
    );

    expect(out.claude_args).toMatch(/--setting-sources user(?= |$)/);
  });

  it("installs nothing for a config without servers", async () => {
    const run = await setup(hi);

    const out = await prepare(run.deps());

    expect(out.claude_args).not.toContain("--settings");
    expect(out.claude_args).not.toContain("--setting-sources");
    await expect(readToolPolicy(run.stateDir)).rejects.toThrow(/ENOENT/);
  });

  it("lets the audit fail a turn whose call the saved policy refuses", async () => {
    const { run } = await prepared(linearConfig(), FORBID_DELETE_UNLESS_ALLOWED_ID);
    const execution = (id: string) =>
      writeTempFile(
        "execution.json",
        executionWithCalls([{ name: "mcp__linear__delete_issue", input: { id } }]),
      );

    await expect(auditToolCalls(run.stateDir, await execution("ENG-1"))).resolves.toBeUndefined();
    await expect(auditToolCalls(run.stateDir, await execution("ENG-9"))).rejects.toThrow(
      /forbidden by policy repo\.1/,
    );
  });

  it.each<[string, string, RegExp]>([
    ["an action typo", FORBID_ACTION_TYPO, /operator policy is invalid: repo: .*CallTools/],
    ["an impossible policy", FORBID_SIBLING_ONLY, /operator policy is invalid: repo: .*impossible/],
  ])("fails before any poster call on %s", async (_name, policy, message) => {
    const run = await setup(hi, linearConfig());

    await expect(
      prepare(run.deps({ env: APPROVAL_ENV, mcpPolicy: withPolicy(policy) })),
    ).rejects.toThrow(message);
    expect(run.aws.requests).toEqual([]);
  });

  it("fails on a tool name that allowed_tools does not list", async () => {
    const run = await setup(hi, linearToolsConfig("mcp__linear__get_issue"));

    await expect(
      prepare(
        run.deps({
          env: APPROVAL_ENV,
          mcpPolicy: withPolicy(forbidToolLiteral("linear", "delete_issue")),
        }),
      ),
    ).rejects.toThrow(/tool "delete_issue" is not in allowed_tools/);
  });

  it("warns, and still runs, when a wildcard covers a named tool", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await prepared(linearConfig(), FORBID_DELETE_UNLESS_ALLOWED_ID);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::.*wildcard/));
  });

  it("checks a policy file the same way at registration", async () => {
    const { issues } = await checkRepositoryMcpPolicy(
      parseConfigOrThrow(linearConfig()),
      withPolicy(FORBID_ACTION_TYPO),
    );

    expect(issues).toEqual([
      { path: "mcp_servers.linear", message: expect.stringMatching(/CallTools/) },
    ]);
  });

  it("writes nothing into the workspace", async () => {
    const { run } = await prepared(linearConfig(), FORBID_DELETE_UNLESS_ALLOWED_ID);

    await expect(readFile(join(run.root, "tool-policy.json"))).rejects.toThrow(/ENOENT/);
  });
});
