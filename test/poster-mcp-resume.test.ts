import { describe, expect, it } from "vitest";
import { APPROVAL_EMOJI } from "../src/lambda/approval-reactions.js";
import { threadKey } from "../src/thread-key.js";
import { ADMIN_ID, MCP_MESSAGE_ID, MCP_SUBJECT, MCP_THREAD_ID } from "./helpers/access-fixtures.js";
import { LINEAR, mcpApprovalsPoster } from "./helpers/mcp-approvals-fixtures.js";

const RESUME = [
  "octo/garden",
  "centaur-message",
  {
    bot: "garden",
    thread_id: MCP_THREAD_ID,
    thread_key: threadKey("garden", MCP_THREAD_ID),
    message_id: MCP_MESSAGE_ID,
  },
] as const;

describe("a suspend call after the decision", () => {
  it.each([
    ["approved", "/approve"],
    ["denied", "/deny"],
  ] as const)(
    "resumes the thread once when the request was %s before it",
    async (status, command) => {
      const h = await mcpApprovalsPoster();
      await h.statuses();
      await h.decide(command);
      expect(h.dispatcher.dispatch).not.toHaveBeenCalled();

      expect(await h.statuses({ suspend: true })).toEqual({ servers: { linear: status } });

      expect(h.dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(...RESUME);
    },
  );

  it("resumes once however many servers were decided", async () => {
    const h = await mcpApprovalsPoster({ approved: true });
    await h.store.recordDenial("mcp", "notion:0123456789abcdef", ADMIN_ID);

    await h.statuses({
      suspend: true,
      servers: [LINEAR, { ...LINEAR, name: "notion" }, { ...LINEAR, name: "slack" }],
    });

    expect(h.dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it("propagates a failed dispatch", async () => {
    const h = await mcpApprovalsPoster({ approved: true });
    h.dispatcher.dispatch.mockRejectedValueOnce(new Error("HTTP 502"));

    await expect(h.statuses({ suspend: true })).rejects.toThrow("HTTP 502");
  });
});

describe("the waiting reaction", () => {
  it("is set on the triggering message when the call suspends a pending request", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses({ suspend: true });

    expect(h.addReaction).toHaveBeenCalledExactlyOnceWith(
      MCP_THREAD_ID,
      MCP_MESSAGE_ID,
      APPROVAL_EMOJI.telegram.emoji.waiting,
    );
  });

  it("is not set by a call that does not suspend", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses();

    expect(h.addReaction).not.toHaveBeenCalled();
  });

  it("gives way to the decision that landed while the call marked the request", async () => {
    const h = await mcpApprovalsPoster({ decideWhileMarking: "/approve" });
    await h.statuses();

    await h.statuses({ suspend: true });

    expect(h.addReaction.mock.calls.at(-1)?.[2]).toBe(APPROVAL_EMOJI.telegram.emoji.approved);
  });
});

describe("a suspend call before the decision", () => {
  it("leaves the resume to the decision handler", async () => {
    const h = await mcpApprovalsPoster();
    await h.statuses();

    expect(await h.statuses({ suspend: true })).toEqual({ servers: { linear: "pending" } });
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
    await h.decide("/approve");

    expect(h.dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(...RESUME);
  });

  it.each([
    ["approved", "/approve"],
    ["denied", "/deny"],
  ] as const)(
    "resumes the thread when the request is %s while it is marked",
    async (status, command) => {
      const h = await mcpApprovalsPoster({ decideWhileMarking: command });
      await h.statuses();

      expect(await h.statuses({ suspend: true })).toEqual({ servers: { linear: status } });

      expect(h.dispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(...RESUME);
      expect(await h.store.read((await h.pendingRequest())?.id ?? "")).toBeNull();
    },
  );
});

describe("a call that does not suspend", () => {
  it.each([
    ["without suspend", {}],
    ["without a thread", { threadId: undefined, messageId: undefined }],
  ])("never dispatches %s", async (_name, overrides) => {
    const h = await mcpApprovalsPoster({ approved: true });
    await h.store.recordDenial("mcp", MCP_SUBJECT, ADMIN_ID);

    await h.statuses(overrides);

    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });
});
