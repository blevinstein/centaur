import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_APPROVAL_SERVERS_MAX } from "../src/poster-contract.js";
import { extractResult, waitingReply } from "../src/workflows/finish.js";
import { prepare } from "../src/workflows/prepare.js";
import { replySchema } from "../src/workflows/prompt.js";
import { NOTHING_PROCESSED } from "../src/workflows/transcript.js";
import { readTurnState } from "../src/workflows/turn-state.js";
import {
  APPROVAL_ENV,
  approvalDeps,
  approvalPolicyDeps,
  fakeMcpApprovals,
  finishAfterApprovalTurn,
  lastProcessed,
  linearConfig,
  posterAnswering,
  RESUME_CONTEXT,
  twoServerConfig,
} from "./helpers/mcp-approval-turn-fixtures.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  BOUND_THREAD,
  operationsOf,
  prepareScheduled,
  readPrompt,
  scheduledSetup,
  setup,
} from "./helpers/turn-fixtures.js";
import {
  botMessage,
  executionText,
  message,
  schemaOptions,
  THREAD,
  THREAD_PREFIX,
} from "./helpers/workflow-fixtures.js";

const hi = [message("1", "hi")];
const SUSPEND_SENTENCE = 'return "suspend_for" with the server name(s)';
const pendingLinear = () => fakeMcpApprovals({ linear: "pending" });

describe("suspend_for", () => {
  afterEach(() => vi.restoreAllMocks());

  it("suspends: posts the reply, saves the session, keeps the marker and marks the request", async () => {
    const run = await setup(hi, linearConfig(RESUME_CONTEXT));
    const asked = pendingLinear();

    await finishAfterApprovalTurn(run, asked, {
      reply: "Waiting for the admin to approve linear.",
      suspend_for: ["linear"],
    });

    expect(operationsOf(run.aws)).toEqual(["read", "post", "unreact"]);
    expect(run.aws.requests.find((r) => r.operation === "post")).toMatchObject({
      text: "Waiting for the admin to approve linear.",
    });
    expect(lastProcessed(run.aws)).toBe(NOTHING_PROCESSED);
    expect(run.aws.objects.get(`${THREAD_PREFIX}s1.jsonl`)).toBe("data");
    expect(asked).toHaveBeenCalledTimes(2);
    const [prepared, suspended] = asked.mock.calls.map(([request]) => request);
    expect(suspended).toEqual({
      ...prepared,
      token: "jwt",
      suspend: true,
    });
    expect(prepared).not.toHaveProperty("suspend");
  });

  it("resumes a fresh thread's suspended question after the waiting reply is posted", async () => {
    const first = await setup(hi, linearConfig(RESUME_CONTEXT));
    await finishAfterApprovalTurn(first, pendingLinear(), {
      reply: "Waiting.",
      suspend_for: ["linear"],
    });

    const resumed = await setup([...hi, botMessage("2", "Waiting.")], linearConfig());
    const approved = fakeMcpApprovals({ linear: "approved" });
    const marker = lastProcessed(first.aws);
    if (marker !== undefined) resumed.aws.objects.set(`${THREAD_PREFIX}last-processed`, marker);

    expect(await prepare(approvalDeps(resumed, approved))).toMatchObject({ skip: false });
    expect(await readPrompt(resumed.root)).toContain("hi");
  });

  it("clears the 👀 reaction before the suspend call, leaving the waiting reaction last", async () => {
    const run = await setup(hi, linearConfig(RESUME_CONTEXT));
    const asked = pendingLinear();
    const seenAtSuspend: string[] = [];
    asked.mockImplementation(async (request) => {
      if (request.suspend) seenAtSuspend.push(...operationsOf(run.aws));
      return { servers: { linear: "pending" } };
    });

    await finishAfterApprovalTurn(run, asked, { reply: "Waiting.", suspend_for: ["linear"] });

    expect(seenAtSuspend).toEqual(["read", "post", "unreact"]);
    expect(operationsOf(run.aws).filter((operation) => operation === "unreact")).toHaveLength(1);
  });

  it("suspends without a reply by posting the shared waiting line", async () => {
    const run = await setup(hi, linearConfig(RESUME_CONTEXT));
    const asked = pendingLinear();

    await finishAfterApprovalTurn(run, asked, { suspend_for: ["linear"] });

    expect(run.aws.requests.filter((r) => r.operation === "post")).toMatchObject([
      { text: waitingReply(["linear"]) },
    ]);
    expect(lastProcessed(run.aws)).toBe(NOTHING_PROCESSED);
    expect(asked.mock.calls[1]?.[0]).toMatchObject({ suspend: true });
  });

  it.each([
    ["names only servers that are not pending", { suspend_for: ["unknown"] }],
    ["has neither a reply, ignore nor suspend_for", {}],
    ["has an empty suspend_for", { suspend_for: [] }],
    ["has a reply together with ignore", { reply: "x", ignore: true }],
  ])("fails when the output %s", async (_name, output) => {
    const run = await setup(hi, linearConfig());

    await expect(finishAfterApprovalTurn(run, pendingLinear(), output)).rejects.toThrow(
      /no structured reply/,
    );
    expect(operationsOf(run.aws)).not.toContain("post");
  });

  it("suspends only for the named pending servers", async () => {
    const run = await setup(hi, twoServerConfig());
    const asked = fakeMcpApprovals({ linear: "pending", docs: "pending" });

    await finishAfterApprovalTurn(run, asked, { reply: "Waiting.", suspend_for: ["docs"] });

    expect(asked.mock.calls[1]?.[0].servers.map(({ name }) => name)).toEqual(["docs"]);
  });

  it("ignores servers that were not pending when the turn started", async () => {
    const run = await setup(hi, twoServerConfig());
    const asked = fakeMcpApprovals({ linear: "pending", docs: "approved" });

    await finishAfterApprovalTurn(run, asked, {
      reply: "ok",
      suspend_for: ["docs", "unknown"],
    });

    expect(asked).toHaveBeenCalledOnce();
    expect(lastProcessed(run.aws)).toBe("1");
  });

  it("does not suspend a denied server's turn", async () => {
    const run = await setup(hi, linearConfig());
    const asked = fakeMcpApprovals({ linear: "denied" });

    await finishAfterApprovalTurn(run, asked, { reply: "ok", suspend_for: ["linear"] });

    expect(asked).toHaveBeenCalledOnce();
    expect(lastProcessed(run.aws)).toBe("1");
  });

  it("behaves as before without suspend_for", async () => {
    const run = await setup(hi, linearConfig());
    const asked = pendingLinear();

    await finishAfterApprovalTurn(run, asked, { reply: "Done." });

    expect(asked).toHaveBeenCalledOnce();
    expect(lastProcessed(run.aws)).toBe("1");
  });

  it("advances the marker and logs only the error type when the suspend call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await setup(hi, linearConfig());
    const asked = vi
      .fn()
      .mockResolvedValueOnce({ servers: { linear: "pending" } })
      .mockRejectedValueOnce(new Error("plans for secret"));

    await finishAfterApprovalTurn(run, asked, { reply: "ok", suspend_for: ["linear"] });

    expect(lastProcessed(run.aws)).toBe("1");
    expect(operationsOf(run.aws)).toEqual(["read", "post", "unreact"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/could not suspend/);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret|sprout|telegram/);
  });

  it("records nothing to suspend for a scheduled prompt and advances its marker", async () => {
    const config = linearConfig("prompts: {weekly: {destination: household, thread: persistent}}");
    const run = await scheduledSetup(hi, config, BOUND_THREAD);
    const asked = pendingLinear();

    await prepareScheduled({ ...run, deps: (overrides) => approvalDeps(run, asked, overrides) });

    expect(await readTurnState(run.stateDir)).not.toHaveProperty("suspend");
    expect(await readPrompt(run.root)).not.toContain(SUSPEND_SENTENCE);
  });

  it("records nothing to suspend for a pull request comment turn", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "hi")],
      messages: hi,
      config: linearConfig(),
      mcpPolicy: approvalPolicyDeps(),
    });

    await prepare({
      ...run.deps(),
      env: APPROVAL_ENV,
      poster: posterAnswering(run.aws.poster, pendingLinear()),
    });

    expect(await readTurnState(run.stateDir)).not.toHaveProperty("suspend");
    expect(await readPrompt(run.root)).not.toContain(SUSPEND_SENTENCE);
  });
});

describe("the suspend_for prompt sentence and schema", () => {
  it("is offered for a chat turn with a pending server and a thread", async () => {
    const run = await setup(hi, linearConfig());

    const out = await prepare(approvalDeps(run, pendingLinear()));

    expect(await readPrompt(run.root)).toContain(SUSPEND_SENTENCE);
    expect(await readPrompt(run.root)).toContain('and a "reply" saying plainly');
    expect(await readTurnState(run.stateDir)).toMatchObject({
      suspend: { thread: { threadId: THREAD, messageId: "1" }, servers: [{ name: "linear" }] },
    });
    expect(out.claude_args).toContain("suspend_for");
  });

  it.each([
    ["approved", { linear: "approved" }],
    ["denied", { linear: "denied" }],
  ] as const)("is absent when the server is %s", async (_status, statuses) => {
    const run = await setup(hi, linearConfig());

    const out = await prepare(approvalDeps(run, fakeMcpApprovals(statuses)));

    expect(await readPrompt(run.root)).not.toContain(SUSPEND_SENTENCE);
    expect(out.claude_args).not.toContain("suspend_for");
  });

  it("is absent when the approval read fails, since no request was raised to resume from", async () => {
    const run = await setup(hi, linearConfig());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await prepare(approvalDeps(run, fakeMcpApprovals(new Error("down"))));

    expect(await readPrompt(run.root)).toContain("awaiting admin approval");
    expect(await readPrompt(run.root)).not.toContain(SUSPEND_SENTENCE);
    expect(await readTurnState(run.stateDir)).not.toHaveProperty("suspend");
  });

  it("is absent for a scheduled prompt without a thread", async () => {
    const run = await setup([], twoServerConfig("prompts: {weekly: {destination: household}}"));

    await prepareScheduled({
      ...run,
      deps: (overrides) =>
        approvalDeps(run, fakeMcpApprovals({ linear: "pending", docs: "pending" }), overrides),
    });

    expect(await readPrompt(run.root)).not.toContain(SUSPEND_SENTENCE);
  });

  it("bounds the field to the pending servers and the poster's server limit", () => {
    const schema = replySchema(schemaOptions({ suspendable: ["linear", "docs"] }));
    expect(schema.properties.suspend_for).toMatchObject({
      type: "array",
      items: { enum: ["linear", "docs"] },
      uniqueItems: true,
      maxItems: MCP_APPROVAL_SERVERS_MAX,
    });
    expect(replySchema(schemaOptions()).properties).not.toHaveProperty("suspend_for");
  });

  it("extracts suspend_for and rejects more entries than the poster takes", () => {
    expect(
      extractResult(executionText({ reply: "x", suspend_for: ["linear"] })).suspendFor,
    ).toEqual(["linear"]);
    const tooMany = Array.from({ length: MCP_APPROVAL_SERVERS_MAX + 1 }, (_, i) => `s${i}`);
    expect(() => extractResult(executionText({ reply: "x", suspend_for: tooMany }))).toThrow(
      /no structured reply/,
    );
  });
});
