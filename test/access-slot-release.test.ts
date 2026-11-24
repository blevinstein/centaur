import { describe, expect, it } from "vitest";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import {
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
