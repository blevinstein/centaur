import { describe, expect, it, vi } from "vitest";
import { MCP_MESSAGE_ID, MCP_SUBJECT, MCP_THREAD_ID } from "./helpers/access-fixtures.js";
import { LINEAR, mcpApprovalsPoster } from "./helpers/mcp-approvals-fixtures.js";

describe("poster mcp-approvals results", () => {
  it("answers approved when the SSM record exists, without asking", async () => {
    const h = await mcpApprovalsPoster({ approved: true });

    expect(await h.statuses()).toEqual({ servers: { linear: "approved" } });
    expect(h.adminPost).not.toHaveBeenCalled();
  });

  it("answers denied while the denial record lasts, without asking", async () => {
    const h = await mcpApprovalsPoster();
    await h.store.recordDenial(MCP_SUBJECT);

    expect(await h.statuses()).toEqual({ servers: { linear: "denied" } });
    expect(h.adminPost).not.toHaveBeenCalled();
  });

  it("prefers the approval over a denial record", async () => {
    const h = await mcpApprovalsPoster({ approved: true });
    await h.store.recordDenial(MCP_SUBJECT);

    expect(await h.statuses()).toEqual({ servers: { linear: "approved" } });
  });

  it("raises one request and answers pending when there is no decision", async () => {
    const h = await mcpApprovalsPoster();

    expect(await h.statuses()).toEqual({ servers: { linear: "pending" } });

    expect(h.adminPost).toHaveBeenCalledOnce();
    expect(h.adminPost.mock.calls[0]?.[0].raw).toContain("Server: linear");
    expect(await h.pendingRequest()).toMatchObject({
      kind: "mcp",
      subjectId: MCP_SUBJECT,
      threadId: MCP_THREAD_ID,
      messageId: MCP_MESSAGE_ID,
    });
  });

  it("answers each server of one call", async () => {
    const h = await mcpApprovalsPoster({ approved: true });

    const result = await h.statuses({
      servers: [LINEAR, { ...LINEAR, name: "notion" }],
    });

    expect(result.servers).toEqual({ linear: "approved", notion: "pending" });
  });
});

describe("repeated reads", () => {
  it("create no second request and no second DM", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses();
    await h.statuses();
    await h.statuses();

    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("do not set the suspended flag", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses();
    await h.statuses();

    expect((await h.pendingRequest())?.suspended).toBeUndefined();
  });

  it("mark a pending request suspended with the thread and message, and a later plain read keeps it", async () => {
    const h = await mcpApprovalsPoster();
    await h.statuses();

    expect(
      await h.statuses({
        suspend: true,
        threadId: "telegram:-100500:9",
        messageId: "telegram:-100500:9",
      }),
    ).toEqual({ servers: { linear: "pending" } });
    await h.statuses();

    expect(await h.pendingRequest()).toMatchObject({
      suspended: true,
      threadId: "telegram:-100500:9",
      messageId: "telegram:-100500:9",
    });
    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("create a request already suspended when suspending is the first read", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses({ suspend: true });

    expect(await h.pendingRequest()).toMatchObject({ suspended: true });
    expect(h.adminPost).toHaveBeenCalledOnce();
  });
});

describe("without a thread", () => {
  const threadless = { threadId: undefined, messageId: undefined };

  it.each([
    ["approved", { approved: true }, "approved"],
    ["denied", {}, "denied"],
    ["pending", {}, "pending"],
  ] as const)("reads a stored decision and answers %s", async (_name, options, expected) => {
    const h = await mcpApprovalsPoster(options);
    if (expected === "denied") await h.store.recordDenial(MCP_SUBJECT);

    expect(await h.statuses(threadless)).toEqual({ servers: { linear: expected } });
  });

  it("never raises a request or sends a DM", async () => {
    const h = await mcpApprovalsPoster();

    await h.statuses(threadless);

    expect(h.adminPost).not.toHaveBeenCalled();
    expect(await h.pendingRequest()).toBeNull();
  });
});

describe("request limits", () => {
  it("stops raising requests at the hourly limit and still answers pending", async () => {
    const h = await mcpApprovalsPoster();
    const servers = Array.from({ length: 12 }, (_, index) => ({
      ...LINEAR,
      name: `server-${index}`,
    }));

    const result = await h.statuses({ servers });

    expect(Object.values(result.servers)).toEqual(Array(12).fill("pending"));
    expect(h.adminPost).toHaveBeenCalledTimes(10);
  });
});

describe("request validation and authority", () => {
  it.each([
    ["a top-level key", { repository: "octo/garden" }],
    ["a server key", { servers: [{ ...LINEAR, extra: true }] }],
    ["no servers", { servers: [] }],
    ["more than 20 servers", { servers: Array(21).fill(LINEAR) }],
    ["an over-long summary", { servers: [{ ...LINEAR, summary: "x".repeat(2001) }] }],
    ["a lone threadId", { messageId: undefined }],
    ["a lone messageId", { threadId: undefined }],
    ["suspend without a thread", { threadId: undefined, messageId: undefined, suspend: true }],
  ])("rejects %s", async (_name, overrides) => {
    const h = await mcpApprovalsPoster();

    await expect(h.statuses(overrides)).rejects.toThrow();
    expect(h.adminPost).not.toHaveBeenCalled();
  });

  it("refuses a token whose repository is not the bot's bound repository", async () => {
    const h = await mcpApprovalsPoster({ repository: "octo/sprout" });

    await expect(h.statuses()).rejects.toThrow('bot "garden" is not bound to octo/sprout');
    expect(h.adminPost).not.toHaveBeenCalled();
    expect(h.oidc.verify).toHaveBeenCalledWith("jwt");
  });
});

describe("no admin", () => {
  it("answers denied, records nothing and logs only the bot and platform", async () => {
    const h = await mcpApprovalsPoster({ admin: false });

    expect(await h.statuses()).toEqual({ servers: { linear: "denied" } });

    expect(h.adminPost).not.toHaveBeenCalled();
    expect(await h.pendingRequest()).toBeNull();
    expect(await h.store.isDenied(MCP_SUBJECT)).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      bot: "garden",
      platform: "telegram",
    });
  });
});

describe("failures", () => {
  it("propagates an SSM read error instead of answering approved", async () => {
    const h = await mcpApprovalsPoster({ approved: true });
    const get = h.params.get.bind(h.params);
    vi.spyOn(h.params, "get").mockImplementation(async (name) => {
      if (name.includes("/mcp-approvals/")) throw new Error("ssm unavailable");
      return get(name);
    });

    await expect(h.statuses()).rejects.toThrow("ssm unavailable");
  });

  it("propagates a state error", async () => {
    const h = await mcpApprovalsPoster();
    vi.spyOn(h.botState, "setIfNotExists").mockRejectedValue(new Error("state unavailable"));

    await expect(h.statuses()).rejects.toThrow("state unavailable");
    expect(h.adminPost).not.toHaveBeenCalled();
  });

  it("answers pending when the admin cannot be reached", async () => {
    const h = await mcpApprovalsPoster();
    h.chatMock.openDM.mockRejectedValue(new Error("chat not found"));

    expect(await h.statuses()).toEqual({ servers: { linear: "pending" } });
    expect(await h.pendingRequest()).toBeNull();
  });
});
