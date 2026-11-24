import { describe, expect, it } from "vitest";
import { COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import {
  APPROVER_KINDS,
  loadApprovers,
  MAX_APPROVERS,
  mayDecide,
} from "../src/lambda/approvers.js";
import { approverParameter } from "../src/lambda/connection-paths.js";
import {
  ADMIN_ID,
  APPROVER_ID,
  approverEntries,
  commandFrom,
  dmChannelId,
  MCP_APPROVAL_PARAMETER,
  mcpHarness,
  OTHER_APPROVER_ID,
  pendingAccessHarness,
} from "./helpers/access-fixtures.js";
import { GARDEN_BOT, SLACK_BOT, STRANGER_USER_ID } from "./helpers/receiver-fixtures.js";

const APPROVED_USER = "/centaur/bots/garden/platforms/telegram/approved-users/9999";

describe("mayDecide", () => {
  const roles = { admin: ADMIN_ID, approvers: new Set([APPROVER_ID]) };

  it.each([
    ["the admin, any kind", ADMIN_ID, "chat", true],
    ["the admin, a kind outside the gate", ADMIN_ID, "approver", true],
    ["an approver, a gated kind", APPROVER_ID, "mcp", true],
    ["an approver, an ungated kind", APPROVER_ID, "approver", false],
    ["an approver, chat", APPROVER_ID, "chat", false],
    ["a stranger, a gated kind", STRANGER_USER_ID, "mcp", false],
  ])("%s", (_name, userId, kind, expected) => {
    expect(mayDecide({ ...roles, userId, kind })).toBe(expected);
  });

  it("lets nobody decide when the platform has no admin", () => {
    expect(mayDecide({ ...roles, admin: undefined, userId: APPROVER_ID, kind: "mcp" })).toBe(false);
  });

  it("gates approvers to mcp only, with a cap of ten", () => {
    expect(APPROVER_KINDS).toEqual(["mcp"]);
    expect(MAX_APPROVERS).toBe(10);
  });
});

describe("loadApprovers", () => {
  it("reads the connection's set and skips malformed entries", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });
    h.params.values[approverParameter("garden", "telegram", "6003")] = "not json";

    expect([...(await loadApprovers(h.params, "garden", "telegram"))]).toEqual([APPROVER_ID]);
  });
});

describe("an approver deciding an mcp request", () => {
  it("approves by reaction and records who approved", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID }));

    expect(JSON.parse(h.params.values[MCP_APPROVAL_PARAMETER] as string)).toMatchObject({
      approver: APPROVER_ID,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      "access request decided",
      expect.objectContaining({
        bot: "garden",
        platform: "telegram",
        kind: "mcp",
        verdict: "approve",
        approverId: APPROVER_ID,
      }),
    );
  });

  it("approves with /approve", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    const reply = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(), { userId: APPROVER_ID }),
    );

    expect(reply).toBe(`Approved mcp ${h.requestId()}.`);
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeDefined();
  });

  it("denies and stores the approver in the denial record", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(h.reaction("👎", { userId: APPROVER_ID }));

    expect(await h.store.isDenied("mcp", "linear:0123456789abcdef")).toBe(true);
    expect(await h.state.get("denied:mcp:linear:0123456789abcdef")).toMatchObject({
      approver: APPROVER_ID,
    });
  });

  it("makes one decision when two approvers decide at once", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID, OTHER_APPROVER_ID] });

    await Promise.all([
      h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID })),
      h.decisions.fromReaction(h.reaction("👍", { userId: OTHER_APPROVER_ID })),
    ]);

    expect(h.reactions.addReaction).toHaveBeenCalledOnce();
  });

  it("is refused once the approver is removed between two decisions", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });
    const second = await h.requestMcp({
      name: "other",
      fingerprint: "fedcba9876543210",
      summary: "",
      threadId: "telegram:-100500:8",
      messageId: "telegram:-100500:813",
    });
    expect(second).toBe("raised");
    const first = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(0), { userId: APPROVER_ID }),
    );
    await h.params.delete(approverParameter("garden", "telegram", APPROVER_ID));

    const reply = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(1), { userId: APPROVER_ID }),
    );

    expect(first).toBe(`Approved mcp ${h.requestId(0)}.`);
    expect(reply).toBeUndefined();
  });
});

describe("who is refused", () => {
  it.each(["chat", "user"] as const)("an approver on a %s request", async (kind) => {
    const h = await pendingAccessHarness(kind, { approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(
      h.reaction("👍", { userId: APPROVER_ID, channelId: dmChannelId(ADMIN_ID) }),
    );
    const reply = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(), { userId: APPROVER_ID }),
    );

    expect(reply).toBe(COMMAND_REPLIES.adminOnly);
    expect(reply).not.toContain(h.requestId());
    expect(h.params.values[APPROVED_USER]).toBeUndefined();
    expect(h.invalidateAccess).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("approver may not decide"),
      expect.objectContaining({ userId: APPROVER_ID }),
    );
    await h.decisions.fromReaction(h.reaction("👍"));
    expect(h.invalidateAccess).toHaveBeenCalledOnce();
  });

  it("a stranger, as before, with no reply", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(h.reaction("👍", { userId: STRANGER_USER_ID }));
    const reply = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(), { userId: STRANGER_USER_ID }),
    );

    expect(reply).toBeUndefined();
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
  });

  it.each([
    ["another platform", SLACK_BOT],
    ["another bot", { ...GARDEN_BOT, name: "other" }],
  ])("an approver of %s", async (_name, bot) => {
    const h = await mcpHarness();
    Object.assign(h.params.values, approverEntries(bot, [APPROVER_ID]));

    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID }));
    const reply = await h.decisions.fromCommand(
      commandFrom("/approve", h.requestId(), { userId: APPROVER_ID }),
    );

    expect(reply).toBeUndefined();
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
  });

  it("an approver when the platform has no admin", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });
    delete h.params.values["/centaur/admin/telegram"];

    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID }));

    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
  });

  it("an approver's reaction outside a direct message", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID, isDM: false }));

    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeUndefined();
  });
});
