import { describe, expect, it, vi } from "vitest";
import { COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import { APPROVAL_EMOJI } from "../src/lambda/approval-reactions.js";
import { DispatchError } from "../src/lambda/github.js";
import { threadKey } from "../src/thread-key.js";
import {
  ADMIN_ID,
  accessHarness,
  MCP_APPROVAL_PARAMETER,
  MCP_MESSAGE_ID,
  MCP_SUBJECT,
  MCP_THREAD_ID,
  mcpHarness,
  mcpInput,
  strandedMcpSlot,
} from "./helpers/access-fixtures.js";
import { STRANGER_USER_ID } from "./helpers/receiver-fixtures.js";

const RESUME_PAYLOAD = {
  bot: "garden",
  thread_id: MCP_THREAD_ID,
  thread_key: threadKey("garden", MCP_THREAD_ID),
  message_id: MCP_MESSAGE_ID,
};

describe("an MCP approval request", () => {
  it("DMs the admin the bot, repository and summary, never message content", async () => {
    const h = await mcpHarness();

    expect(h.outcome).toBe("raised");
    const text = h.adminText();
    expect(text).toContain(`Access request ${h.requestId()}`);
    expect(text).toContain("Bot: garden");
    expect(text).toContain("Kind: mcp");
    expect(text).toContain("Repository: octo/garden");
    expect(text).toContain("Server: linear");
    expect(text).toContain("Summary: http https://mcp.example.com/mcp, secrets LINEAR_TOKEN");
    expect(text).toContain(`/approve ${h.requestId()}`);
    expect(text).toContain("to deny.");
  });

  it("stores the subject, thread, message and suspended flag, and links the DM", async () => {
    const h = await mcpHarness({}, { suspended: true });

    expect(await h.store.read(h.requestId())).toMatchObject({
      kind: "mcp",
      subjectId: MCP_SUBJECT,
      threadId: MCP_THREAD_ID,
      messageId: MCP_MESSAGE_ID,
      suspended: true,
    });
    expect(await h.linkedRequestId()).toBe(h.requestId());
  });

  it("limits the summary to one line of bounded length", async () => {
    const h = await mcpHarness({}, { summary: `first\nsecond ${"x".repeat(2000)}` });

    const stored = await h.store.read(h.requestId());
    expect(stored?.summary).toHaveLength(500);
    expect(stored?.summary).not.toContain("\n");
  });

  it("keeps one pending request per subject and does not re-send it", async () => {
    const h = await mcpHarness();

    expect(await h.requestMcp(mcpInput())).toBe("pending");

    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("asks separately for a changed definition of the same server", async () => {
    const h = await mcpHarness();

    expect(await h.requestMcp(mcpInput({ fingerprint: "fedcba9876543210" }))).toBe("raised");

    expect(h.adminPost).toHaveBeenCalledTimes(2);
  });

  it("drops requests over the hourly cap", async () => {
    const h = await mcpHarness({ limits: { perHour: 1 } });

    expect(await h.requestMcp(mcpInput({ name: "notion" }))).toBe("limited");

    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("reports an unreachable admin and allows another attempt", async () => {
    const h = await mcpHarness({ dmFails: true });

    expect(h.outcome).toBe("unreachable");
    expect(await h.requestMcp(mcpInput())).toBe("unreachable");
    expect(h.messenger.openDM).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the bot has no admin", async () => {
    const h = await mcpHarness({ admin: null });

    expect(h.outcome).toBeUndefined();
    expect(h.messenger.openDM).not.toHaveBeenCalled();
  });
});

describe("an MCP approval decision", () => {
  it("records the approval, shows it as a reaction and does not dispatch an unsuspended request", async () => {
    const h = await mcpHarness();

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(JSON.parse(h.params.values[MCP_APPROVAL_PARAMETER] as string)).toMatchObject({
      approver: "5001",
    });
    expect(h.postToThread).not.toHaveBeenCalled();
    expect(h.reactions.addReaction).toHaveBeenCalledExactlyOnceWith(
      MCP_THREAD_ID,
      MCP_MESSAGE_ID,
      APPROVAL_EMOJI.telegram.emoji.approved,
    );
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(h.invalidateAccess).not.toHaveBeenCalled();
  });

  it("decides and dispatches even when the reaction fails", async () => {
    const h = await mcpHarness({}, { suspended: true });
    h.reactions.addReaction.mockRejectedValueOnce(new Error("MESSAGE_ID_INVALID"));

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeDefined();
    expect(h.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledWith("failed to show the approval state", {
      bot: "garden",
      platform: "telegram",
      state: "approved",
    });
  });

  it("reacts to nothing for a request without a message", async () => {
    const h = await accessHarness();
    const request = await strandedMcpSlot(h);

    await h.decisions.fromCommand({
      command: "/approve",
      text: request.id,
      user: { userId: ADMIN_ID },
      isDM: true,
    });

    expect(h.reactions.addReaction).not.toHaveBeenCalled();
    expect(h.postToThread).not.toHaveBeenCalled();
  });

  it("resumes a suspended thread with the original message on approval", async () => {
    const h = await mcpHarness({}, { suspended: true });

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(
      "octo/garden",
      "centaur-message",
      RESUME_PAYLOAD,
    );
  });

  it("denies with a TTL record, a reaction and no SSM record", async () => {
    const h = await mcpHarness();

    await h.decisions.fromReaction(h.reaction("👎"));

    expect(await h.store.isDenied("mcp", MCP_SUBJECT)).toBe(true);
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
    expect(h.postToThread).not.toHaveBeenCalled();
    expect(h.reactions.addReaction).toHaveBeenCalledExactlyOnceWith(
      MCP_THREAD_ID,
      MCP_MESSAGE_ID,
      APPROVAL_EMOJI.telegram.emoji.denied,
    );
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("resumes a suspended thread on denial too", async () => {
    const h = await mcpHarness({}, { suspended: true });

    await h.decisions.fromReaction(h.reaction("👎"));

    expect(h.dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(
      "octo/garden",
      "centaur-message",
      RESUME_PAYLOAD,
    );
  });

  it("forgets a denial once its record expires", async () => {
    vi.useFakeTimers();
    try {
      const h = await mcpHarness({ limits: { ttlMs: 1000 } });
      await h.decisions.fromReaction(h.reaction("👎"));
      expect(await h.store.isDenied("mcp", MCP_SUBJECT)).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(await h.store.isDenied("mcp", MCP_SUBJECT)).toBe(false);
      expect(await h.requestMcp(mcpInput())).toBe("raised");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is single-use across a reaction and /approve: one dispatch", async () => {
    const h = await mcpHarness({}, { suspended: true });

    await h.decisions.fromReaction(h.reaction("👍"));
    const reply = await h.decisions.fromCommand({
      command: "/approve",
      text: h.requestId(),
      user: { userId: "5001" },
      isDM: true,
    });

    expect(reply).toBe(COMMAND_REPLIES.handled);
    expect(h.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(h.reactions.addReaction).toHaveBeenCalledOnce();
  });

  it("releases the claim when the dispatch fails, so the decision can be retried", async () => {
    const h = await mcpHarness({}, { suspended: true });
    h.dispatcher.dispatch.mockRejectedValueOnce(new Error("HTTP 502"));

    await expect(h.decisions.fromReaction(h.reaction("👍"))).rejects.toThrow("HTTP 502");
    expect(h.postToThread).not.toHaveBeenCalled();
    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(h.reactions.addReaction).toHaveBeenCalledOnce();
  });

  it("notifies the admin once when the re-dispatch fails", async () => {
    const h = await mcpHarness({}, { suspended: true });
    h.dispatcher.dispatch.mockRejectedValueOnce(new DispatchError("octo/garden", 404));

    await expect(h.decisions.fromReaction(h.reaction("👍"))).rejects.toThrow("HTTP 404");

    expect(h.adminPost).toHaveBeenCalledTimes(2);
    expect(h.adminText(1)).toContain("HTTP status: 404");
  });

  it("ignores a decision from anyone but the admin", async () => {
    const h = await mcpHarness({}, { suspended: true });

    await h.decisions.fromReaction(h.reaction("👍", { userId: STRANGER_USER_ID }));
    const reply = await h.decisions.fromCommand({
      command: "/approve",
      text: h.requestId(),
      user: { userId: STRANGER_USER_ID },
      isDM: true,
    });

    expect(reply).toBeUndefined();
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("answers /deny with a reply that does not claim to block", async () => {
    const h = await mcpHarness();

    const reply = await h.decisions.fromCommand({
      command: "/deny",
      text: h.requestId(),
      user: { userId: "5001" },
      isDM: true,
    });

    expect(reply).toBe(`Denied mcp ${h.requestId()}.`);
  });
});
