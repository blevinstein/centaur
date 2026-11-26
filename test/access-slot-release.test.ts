import { describe, expect, it, vi } from "vitest";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import {
  ADMIN_ID,
  accessHarness,
  approverHarness,
  commandFrom,
  MCP_APPROVAL_PARAMETER,
  MCP_SUBJECT,
  mcpHarness,
  mcpInput,
  REQUESTER_ID,
  strandedMcpSlot,
} from "./helpers/access-fixtures.js";
import {
  fakeMessage,
  fakeThread,
  GROUP_CHAT_ID,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";

describe("an MCP request raised again after approve then revoke", () => {
  it("opens a new request with a DM", async () => {
    const h = await mcpHarness();
    await h.decisions.fromReaction(h.reaction("👍"));
    delete h.params.values[MCP_APPROVAL_PARAMETER];

    expect(await h.requestMcp(mcpInput())).toBe("raised");

    expect(h.adminPost).toHaveBeenCalledTimes(2);
    expect(h.requestId(1)).not.toBe(h.requestId(0));
  });
});

describe("the pending slot after a decision", () => {
  it.each([
    ["approval", "👍"],
    ["denial", "👎"],
  ])("is released for an mcp request after an %s", async (_name, emoji) => {
    const h = await mcpHarness();

    await h.decisions.fromReaction(h.reaction(emoji));

    expect(await h.store.claimSubject("mcp", MCP_SUBJECT)).toBe(true);
  });

  it.each([
    ["approval", "👍"],
    ["denial", "👎"],
  ])("is released for an approver request after an %s", async (_name, emoji) => {
    const h = await approverHarness();
    await h.askToBeApprover();

    await h.decisions.fromReaction(h.reaction(emoji));

    expect(await h.store.claimSubject("approver", REQUESTER_ID)).toBe(true);
  });

  it("stays claimed, with the decision claim released, when the dispatch fails", async () => {
    const h = await mcpHarness({}, { suspended: true });
    h.dispatcher.dispatch.mockRejectedValueOnce(new Error("HTTP 502"));

    await expect(h.decisions.fromReaction(h.reaction("👍"))).rejects.toThrow("HTTP 502");

    expect(await h.store.claimSubject("mcp", MCP_SUBJECT)).toBe(false);
    expect(await h.store.isDecided(h.requestId())).toBe(false);
  });

  it("stays claimed when an approver decision is refused at the cap", async () => {
    const h = await approverHarness();
    await h.askToBeApprover();
    h.setApprovers(Array.from({ length: MAX_APPROVERS }, (_, index) => `${8000 + index}`));

    await h.decisions.fromCommand(commandFrom("/approve", h.requestId()));

    expect(await h.store.claimSubject("approver", REQUESTER_ID)).toBe(false);
  });
});

describe("a pending slot left behind", () => {
  it("is replaced when it points at a decided request", async () => {
    const h = await accessHarness();
    await strandedMcpSlot(h, { decided: true });

    expect(await h.requestMcp(mcpInput())).toBe("raised");

    expect(h.adminPost).toHaveBeenCalledOnce();
    expect(await h.store.claimSubject("mcp", MCP_SUBJECT)).toBe(false);
  });

  it("is replaced when it points at a missing request", async () => {
    const h = await accessHarness();
    await h.store.remove(await strandedMcpSlot(h));

    expect(await h.requestMcp(mcpInput())).toBe("raised");
  });

  it("answers pending for a live undecided request, with no second DM", async () => {
    const h = await mcpHarness();

    expect(await h.requestMcp(mcpInput())).toBe("pending");

    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("answers pending while a concurrent request holds only the placeholder", async () => {
    const h = await accessHarness();
    await h.store.claimSubject("mcp", MCP_SUBJECT);

    expect(await h.requestMcp(mcpInput())).toBe("pending");
    expect(h.adminPost).not.toHaveBeenCalled();
  });
});

describe("updatePending", () => {
  it("marks a live request", async () => {
    const h = await accessHarness();
    const request = await strandedMcpSlot(h);

    expect(await h.store.updatePending(MCP_SUBJECT, { suspended: true })).toBe(true);
    expect((await h.store.read(request.id))?.suspended).toBe(true);
  });

  it("leaves a decided request alone", async () => {
    const h = await accessHarness();
    const request = await strandedMcpSlot(h, { decided: true });

    expect(await h.store.updatePending(MCP_SUBJECT, { suspended: true })).toBe(false);
    expect((await h.store.read(request.id))?.suspended).toBeUndefined();
  });
});

describe("a request aborted before the admin could decide", () => {
  const retriesAfter = async (h: Awaited<ReturnType<typeof accessHarness>>) => {
    expect(await h.store.claimSubject("mcp", MCP_SUBJECT)).toBe(true);
    await h.store.releaseSubject("mcp", MCP_SUBJECT);
    expect(await h.requestMcp(mcpInput())).toBe("raised");
    expect(h.adminPost).toHaveBeenCalledOnce();
  };

  it("frees the subject when every DM fails, and a retry raises it", async () => {
    const failing = [ADMIN_ID];
    const h = await accessHarness({ failingUsers: failing });
    expect(await h.requestMcp(mcpInput())).toBe("unreachable");
    failing.length = 0;

    await retriesAfter(h);
  });

  it.each(["overLimit", "create", "recordRequest", "linkSubject"] as const)(
    "frees the subject when the store's %s throws",
    async (step) => {
      const h = await accessHarness();
      vi.spyOn(h.store, step).mockRejectedValueOnce(new Error("state unavailable"));

      await expect(h.requestMcp(mcpInput())).rejects.toThrow("state unavailable");

      await retriesAfter(h);
    },
  );

  it("removes the stored request when a step after creating it throws", async () => {
    const h = await accessHarness();
    const create = vi.spyOn(h.store, "create");
    vi.spyOn(h.store, "linkSubject").mockRejectedValueOnce(new Error("state unavailable"));

    await expect(h.requestMcp(mcpInput())).rejects.toThrow("state unavailable");

    const request = await create.mock.results[0]?.value;
    expect(await h.store.read(request.id)).toBeNull();
  });

  it("frees the subject when the description throws", async () => {
    const h = await accessHarness();
    vi.spyOn(h.params, "getByPath").mockRejectedValueOnce(new Error("ssm unavailable"));

    await expect(
      h.requestAccess(["chat"], fakeThread().thread, fakeMessage({ userId: STRANGER_USER_ID })),
    ).rejects.toThrow("ssm unavailable");

    expect(await h.store.claimSubject("chat", GROUP_CHAT_ID)).toBe(true);
  });

  it("frees the subject when the limit is reached", async () => {
    const h = await accessHarness({ limits: { perHour: 0 } });

    expect(await h.requestMcp(mcpInput())).toBe("limited");

    expect(await h.store.claimSubject("mcp", MCP_SUBJECT)).toBe(true);
  });

  it("frees a reservation whose request was cut off, after a short wait", async () => {
    vi.useFakeTimers();
    try {
      const h = await accessHarness();
      await h.store.claimSubject("mcp", MCP_SUBJECT);
      expect(await h.requestMcp(mcpInput())).toBe("pending");

      vi.advanceTimersByTime(10 * 60_000);

      expect(await h.requestMcp(mcpInput())).toBe("raised");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still blocks after a denied decision on a request that was retried", async () => {
    const failing = [ADMIN_ID];
    const h = await accessHarness({ failingUsers: failing });
    await h.requestMcp(mcpInput());
    failing.length = 0;
    await h.requestMcp(mcpInput());

    await h.decisions.fromReaction(h.reaction("👎"));

    expect(await h.store.isDenied("mcp", MCP_SUBJECT)).toBe(true);
  });
});
