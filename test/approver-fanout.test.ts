import { describe, expect, it } from "vitest";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import {
  ADMIN_ID,
  APPROVER_ID,
  dmChannelId,
  MCP_APPROVAL_PARAMETER,
  mcpHarness,
  mcpInput,
  OTHER_APPROVER_ID,
  pendingAccessHarness,
} from "./helpers/access-fixtures.js";
import { MESSAGE_TEXT } from "./helpers/receiver-fixtures.js";

const openedFor = (h: { messenger: { openDM: { mock: { calls: unknown[][] } } } }) =>
  h.messenger.openDM.mock.calls.map(([userId]) => userId);

describe("an mcp request with approvers", () => {
  it("DMs the admin and each approver, linking every DM to the request", async () => {
    const h = await mcpHarness({ approvers: [OTHER_APPROVER_ID, APPROVER_ID] });

    expect(h.outcome).toBe("raised");
    expect(openedFor(h)).toEqual([ADMIN_ID, APPROVER_ID, OTHER_APPROVER_ID]);
    for (const userId of [ADMIN_ID, APPROVER_ID, OTHER_APPROVER_ID]) {
      expect(await h.linkedRequestId(userId)).toBe(h.requestId());
    }
    expect(h.adminText(2)).toBe(h.adminText(0));
    expect(h.adminText()).not.toContain(MESSAGE_TEXT);
  });

  it("sends exactly the admin DM when there are no approvers", async () => {
    const h = await mcpHarness();

    expect(openedFor(h)).toEqual([ADMIN_ID]);
    expect(h.adminPost).toHaveBeenCalledOnce();
  });

  it("does not DM the admin twice when the admin is in the set", async () => {
    const h = await mcpHarness({ approvers: [ADMIN_ID, APPROVER_ID] });

    expect(openedFor(h)).toEqual([ADMIN_ID, APPROVER_ID]);
  });

  it("sends the DM to the first MAX_APPROVERS approvers in sorted order", async () => {
    const ids = Array.from({ length: MAX_APPROVERS + 3 }, (_, i) => `${7000 + i}`);
    const h = await mcpHarness({ approvers: [...ids].reverse() });

    expect(openedFor(h)).toEqual([ADMIN_ID, ...ids.slice(0, MAX_APPROVERS)]);
  });

  it("keeps messages that share an id in different channels apart", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID], messageIds: ["1", "2", "2", "3"] });
    await h.requestMcp(
      mcpInput({ name: "notion", fingerprint: "fedcba9876543210", threadId: "telegram:-100500:8" }),
    );
    const notion = "/centaur/bots/garden/mcp-approvals/notion/fedcba9876543210";

    await h.decisions.fromReaction(
      h.reaction("👍", {
        userId: APPROVER_ID,
        messageId: "2",
        channelId: dmChannelId(APPROVER_ID),
      }),
    );
    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeDefined();
    expect(h.params.values[notion]).toBeUndefined();

    await h.decisions.fromReaction(
      h.reaction("👍", { userId: ADMIN_ID, messageId: "2", channelId: dmChannelId(ADMIN_ID) }),
    );
    expect(h.params.values[notion]).toBeDefined();
  });

  it("makes one decision across the DMs and leaves the others alone", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID] });

    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID }));
    await h.decisions.fromReaction(h.reaction("👎", { userId: ADMIN_ID }));

    expect(h.params.values[MCP_APPROVAL_PARAMETER]).toBeDefined();
    expect(h.postToThread).toHaveBeenCalledOnce();
    expect(h.adminPost).toHaveBeenCalledTimes(2);
  });

  it("skips a failing DM, logs it without ids and delivers the others", async () => {
    const h = await mcpHarness({
      approvers: [APPROVER_ID, OTHER_APPROVER_ID],
      failingUsers: [APPROVER_ID],
    });

    expect(h.outcome).toBe("raised");
    expect(openedFor(h)).toEqual([ADMIN_ID, APPROVER_ID, OTHER_APPROVER_ID]);
    expect(await h.linkedRequestId(APPROVER_ID)).toBeNull();
    expect(await h.linkedRequestId(OTHER_APPROVER_ID)).toBe(h.requestId());
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      bot: "garden",
      platform: "telegram",
      kind: "mcp",
    });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("is unreachable, and can be raised again, when every DM fails", async () => {
    const h = await mcpHarness({ approvers: [APPROVER_ID], dmFails: true });

    expect(h.outcome).toBe("unreachable");
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    expect(await h.requestMcp(mcpInput())).toBe("unreachable");
    expect(openedFor(h)).toHaveLength(4);
  });
});

describe.each(["chat", "user"] as const)("a %s request with approvers", (kind) => {
  it("DMs the admin alone", async () => {
    const h = await pendingAccessHarness(kind, { approvers: [APPROVER_ID] });

    expect(openedFor(h)).toEqual([ADMIN_ID]);
    expect(await h.linkedRequestId()).toBe(h.requestId());
  });
});
