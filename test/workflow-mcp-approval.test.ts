import { afterEach, describe, expect, it, vi } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import {
  APPROVAL_ENV,
  allowedToolsOf,
  approvalDeps,
  approvalPolicyDeps,
  fakeMcpApprovals,
  LINEAR_SECRET,
  LINEAR_TOOLS,
  linearConfig,
  posterAnswering,
  readMcpServers,
  twoServerConfig,
} from "./helpers/mcp-approval-turn-fixtures.js";
import { fakePolicyGitHub } from "./helpers/mcp-policy-fixtures.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  BOUND_THREAD,
  prepareScheduled,
  readPrompt,
  scheduledSetup,
  setup,
} from "./helpers/turn-fixtures.js";
import { message, THREAD } from "./helpers/workflow-fixtures.js";

const hi = [message("1", "hi")];
const AWAITING = "MCP servers awaiting admin approval and unavailable this turn";

describe("prepare with approval-required MCP servers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps an approved server and its tools, and says nothing about it", async () => {
    const run = await setup(hi, linearConfig());
    const asked = fakeMcpApprovals({ linear: "approved" });

    const out = await prepare(approvalDeps(run, asked));

    expect(await readMcpServers(run.root)).toEqual(["linear"]);
    expect(allowedToolsOf(out.claude_args)).toContain(LINEAR_TOOLS);
    expect(await readPrompt(run.root)).not.toContain("MCP server");
  });

  it("asks once with the thread, the triggering message and a secret-free summary", async () => {
    const run = await setup(hi, linearConfig());
    const asked = fakeMcpApprovals({ linear: "approved" });

    await prepare(approvalDeps(run, asked));

    expect(asked).toHaveBeenCalledOnce();
    const request = asked.mock.calls[0]?.[0];
    expect(request).toMatchObject({ bot: "sprout", threadId: THREAD, messageId: "1" });
    expect(request?.servers).toEqual([
      {
        name: "linear",
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
        summary: `remote mcp.linear.app; secrets: LINEAR_API_KEY; tools: ${LINEAR_TOOLS}`,
      },
    ]);
    expect(JSON.stringify(request)).not.toContain(LINEAR_SECRET);
  });

  it("drops a pending server from mcp.json and the allowed tools and tells the agent", async () => {
    const run = await setup(hi, linearConfig());

    const out = await prepare(approvalDeps(run, fakeMcpApprovals({ linear: "pending" })));

    expect(await readMcpServers(run.root)).toBeUndefined();
    expect(out.claude_args).not.toContain("--mcp-config");
    expect(allowedToolsOf(out.claude_args)).not.toContain(LINEAR_TOOLS);
    expect(await readPrompt(run.root)).toContain(`${AWAITING}: linear (tools: ${LINEAR_TOOLS}).`);
  });

  it("drops a denied server and tells the agent to answer without it", async () => {
    const run = await setup(hi, linearConfig());

    const out = await prepare(approvalDeps(run, fakeMcpApprovals({ linear: "denied" })));

    expect(await readMcpServers(run.root)).toBeUndefined();
    expect(allowedToolsOf(out.claude_args)).not.toContain(LINEAR_TOOLS);
    const prompt = await readPrompt(run.root);
    expect(prompt).toContain("MCP server linear was denied by the admin; answer without it.");
    expect(prompt).not.toContain(AWAITING);
  });

  it("drops only the undecided server, including each of its tool entries", async () => {
    const run = await setup(hi, twoServerConfig());

    const out = await prepare(
      approvalDeps(run, fakeMcpApprovals({ linear: "approved", docs: "pending" })),
    );

    expect(await readMcpServers(run.root)).toEqual(["linear"]);
    expect(allowedToolsOf(out.claude_args)).toEqual(["Read", LINEAR_TOOLS]);
    expect(await readPrompt(run.root)).toContain(
      "docs (tools: mcp__docs__search, mcp__docs__list)",
    );
  });

  it("treats a poster failure as pending without failing the turn or logging its message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await setup(hi, linearConfig());

    const out = await prepare(approvalDeps(run, fakeMcpApprovals(new Error("plans for secret"))));

    expect(out.skip).toBe(false);
    expect(await readMcpServers(run.root)).toBeUndefined();
    expect(await readPrompt(run.root)).toContain(AWAITING);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret|sprout|telegram/);
  });

  it("fails on a policy error before any approval call", async () => {
    const run = await setup(hi, linearConfig());
    const asked = fakeMcpApprovals({ linear: "approved" });

    await expect(
      prepare(approvalDeps(run, asked, { mcpPolicy: fakePolicyGitHub().deps })),
    ).rejects.toThrow(/operator policy/);
    expect(asked).not.toHaveBeenCalled();
  });

  it("asks nothing when no server needs approval", async () => {
    const run = await setup(hi, linearConfig());
    const asked = fakeMcpApprovals({});

    await prepare(
      approvalDeps(run, asked, {
        mcpPolicy: fakePolicyGitHub({ policy: "permit(principal, action, resource);" }).deps,
      }),
    );

    expect(asked).not.toHaveBeenCalled();
    expect(await readMcpServers(run.root)).toEqual(["linear"]);
  });

  it("asks for a scheduled prompt in its persistent thread", async () => {
    const config = linearConfig("prompts: {weekly: {destination: household, thread: persistent}}");
    const run = await scheduledSetup(hi, config, BOUND_THREAD);
    const asked = fakeMcpApprovals({ linear: "pending" });

    await prepareScheduled({ ...run, deps: (overrides) => approvalDeps(run, asked, overrides) });

    expect(asked.mock.calls[0]?.[0]).toMatchObject({ threadId: BOUND_THREAD, messageId: "1" });
    expect(await readMcpServers(run.root)).toBeUndefined();
  });

  it("reads decisions without a thread for a scheduled prompt that has none, keeping approved servers", async () => {
    const config = twoServerConfig("prompts: {weekly: {destination: household}}");
    const run = await setup([], config);
    const asked = fakeMcpApprovals({ linear: "approved", docs: "pending" });

    await prepareScheduled({ ...run, deps: (overrides) => approvalDeps(run, asked, overrides) });

    expect(asked).toHaveBeenCalledOnce();
    expect(asked.mock.calls[0]?.[0]).not.toHaveProperty("threadId");
    expect(asked.mock.calls[0]?.[0]).not.toHaveProperty("messageId");
    expect(await readMcpServers(run.root)).toEqual(["linear"]);
    expect(await readPrompt(run.root)).toContain(AWAITING);
  });

  it("asks for a pull request comment turn in the pull request's thread", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "hi")],
      messages: hi,
      config: linearConfig(),
      mcpPolicy: approvalPolicyDeps(),
    });
    const asked = fakeMcpApprovals({ linear: "pending" });

    const out = await prepare({
      ...run.deps(),
      env: APPROVAL_ENV,
      poster: posterAnswering(run.aws.poster, asked),
    });

    expect(asked.mock.calls[0]?.[0]).toMatchObject({ threadId: THREAD, messageId: "1" });
    expect(allowedToolsOf(out.claude_args)).not.toContain(LINEAR_TOOLS);
    expect(await readMcpServers(run.root)).toBeUndefined();
  });
});
