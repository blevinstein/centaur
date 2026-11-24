import { describe, expect, it } from "vitest";
import { COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import { APPROVER_REPLIES, parseApproverCommand } from "../src/lambda/approver-commands.js";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import {
  ADMIN_ID,
  APPROVER_ID,
  APPROVER_ROUTES,
  approverHarness,
  commandFrom,
  REQUESTER_ID,
  REQUESTER_THREAD_ID,
} from "./helpers/access-fixtures.js";

describe("parseApproverCommand", () => {
  it.each([
    ["approver request", "request"],
    ["  Approver   LEAVE ", "leave"],
  ])("parses %j", (text, sub) => {
    expect(parseApproverCommand(text)).toBe(sub);
  });

  it.each([
    "approver",
    "approver add 1",
    "request",
    "approver request please",
    "hi approver leave",
  ])("ignores %j", (text) => {
    expect(parseApproverCommand(text)).toBeUndefined();
  });
});

describe.each(APPROVER_ROUTES)("approver words through %s", (_route, via) => {
  describe("request", () => {
    it("sends the admin a DM with the requester's ID, the platform and no message content", async () => {
      const h = await approverHarness();

      const { posts } = await via(h, "request");

      expect(posts).toEqual([APPROVER_REPLIES.requested]);
      expect(h.adminText()).toContain("Kind: approver");
      expect(h.adminText()).toContain("Bot: garden");
      expect(h.adminText()).toContain("Platform: telegram");
      expect(h.adminText()).toContain(`Requester: Pat Example (${REQUESTER_ID})`);
      expect(h.adminText()).toContain("React 👍 to approve, or 👎 to deny.");
      expect(h.adminText()).not.toContain("approver request");
      expect(h.messenger.openDM).toHaveBeenCalledWith(ADMIN_ID);
    });

    it.each(["stranger", "blocked"] as const)(
      "falls through for a %s user, sending the admin nothing",
      async (standing) => {
        const h = await approverHarness({ standing });

        const { posts, fellThrough } = await via(h, "request");

        expect(fellThrough).toBe(true);
        expect(posts).not.toContain(APPROVER_REPLIES.requested);
        expect(h.adminText()).not.toContain("Kind: approver");
      },
    );

    it("refuses outside a direct message", async () => {
      const h = await approverHarness();

      const { posts } = await via(h, "request", { isDM: false });

      expect(posts).toEqual([APPROVER_REPLIES.notDirect]);
      expect(h.adminPost).not.toHaveBeenCalled();
    });

    it("keeps one pending request per user", async () => {
      const h = await approverHarness();

      await via(h, "request");
      const { posts } = await via(h, "request");

      expect(posts).toEqual([expect.stringContaining("hasn't answered")]);
      expect(h.adminPost).toHaveBeenCalledOnce();
    });

    it("answers a recent denial without asking again", async () => {
      const h = await approverHarness();
      await via(h, "request");
      await h.decisions.fromReaction(h.reaction("👎"));
      h.postToThread.mockClear();

      const { posts } = await via(h, "request");

      expect(posts).toEqual([APPROVER_REPLIES.denied]);
      expect(h.adminPost).toHaveBeenCalledOnce();
    });

    it("stops at the shared hourly limit", async () => {
      const h = await approverHarness({ limits: { perHour: 0 } });

      const { posts } = await via(h, "request");

      expect(posts).toEqual([APPROVER_REPLIES.limited]);
      expect(h.adminPost).not.toHaveBeenCalled();
    });

    it("says so when the admin cannot be reached", async () => {
      const h = await approverHarness({ dmFails: true });

      const { posts } = await via(h, "request");

      expect(posts).toEqual([expect.stringContaining("couldn't reach my admin")]);
    });

    it("gives the fixed line when the platform has no admin", async () => {
      const h = await approverHarness({ admin: null });

      const { posts } = await via(h, "request");

      expect(posts).toEqual([APPROVER_REPLIES.noAdmin]);
    });

    it.each([
      ["an approver", { approvers: [REQUESTER_ID] }, REQUESTER_ID],
      ["the admin", {}, ADMIN_ID],
    ])("tells %s they already are one", async (_name, options, userId) => {
      const h = await approverHarness(options);

      const { posts } = await via(h, "request", { userId });

      expect(posts).toEqual([APPROVER_REPLIES.already]);
      expect(h.adminPost).not.toHaveBeenCalled();
    });

    it("sends no request once the set is full", async () => {
      const full = Array.from({ length: MAX_APPROVERS }, (_, index) => `${8000 + index}`);
      const h = await approverHarness({ approvers: full });

      const { posts } = await via(h, "request");

      expect(posts).toEqual([APPROVER_REPLIES.full]);
      expect(h.adminPost).not.toHaveBeenCalled();
    });
  });

  describe("leave", () => {
    it("deletes the approver's own entry", async () => {
      const h = await approverHarness({ approvers: [REQUESTER_ID, APPROVER_ID] });

      const { posts } = await via(h, "leave");

      expect(posts).toEqual([APPROVER_REPLIES.left]);
      expect(h.approverEntry()).toBeUndefined();
      expect(h.approverEntry(APPROVER_ID)).toBeDefined();
    });

    it("lets a blocked approver leave", async () => {
      const h = await approverHarness({ approvers: [REQUESTER_ID], standing: "blocked" });

      const { posts } = await via(h, "leave");

      expect(posts).toEqual([APPROVER_REPLIES.left]);
      expect(h.approverEntry()).toBeUndefined();
    });

    it("tells the admin they cannot leave", async () => {
      const h = await approverHarness();

      const { posts } = await via(h, "leave", { userId: ADMIN_ID });

      expect(posts).toEqual([APPROVER_REPLIES.adminCannotLeave]);
    });

    it("tells an approved user who is not an approver", async () => {
      const h = await approverHarness();

      const { posts } = await via(h, "leave");

      expect(posts).toEqual([APPROVER_REPLIES.notApprover]);
    });

    it("falls through for a stranger", async () => {
      const h = await approverHarness({ standing: "stranger" });

      expect((await via(h, "leave")).fellThrough).toBe(true);
    });

    it("refuses outside a direct message and keeps the entry", async () => {
      const h = await approverHarness({ approvers: [REQUESTER_ID] });

      const { posts } = await via(h, "leave", { isDM: false });

      expect(posts).toEqual([APPROVER_REPLIES.notDirect]);
      expect(h.approverEntry()).toBeDefined();
    });
  });
});

describe("the approver request decision", () => {
  it("writes the entry with the deciding admin and the time, then confirms in the requester's DM", async () => {
    const h = await approverHarness();
    await h.askToBeApprover();

    await h.approveRequest();

    expect(JSON.parse(h.approverEntry() ?? "")).toEqual({
      name: "Pat Example",
      approver: ADMIN_ID,
      at: expect.any(String),
    });
    expect(h.invalidateAccess).not.toHaveBeenCalled();
    expect(h.postToThread).toHaveBeenCalledExactlyOnceWith(
      REQUESTER_THREAD_ID,
      "You're now an approver for this bot.",
    );
  });

  it("records the denial for a week, blocks nothing and tells the requester", async () => {
    const h = await approverHarness();
    await h.askToBeApprover();

    await h.decisions.fromReaction(h.reaction("👎"));

    expect(await h.store.isDenied("approver", REQUESTER_ID)).toBe(true);
    expect(h.approverEntry()).toBeUndefined();
    expect(Object.keys(h.params.values).some((name) => name.includes("/blocked/"))).toBe(false);
    expect(h.postToThread).toHaveBeenCalledExactlyOnceWith(
      REQUESTER_THREAD_ID,
      expect.stringContaining("declined"),
    );
  });

  it("refuses an approver deciding it, by command and by reaction", async () => {
    const h = await approverHarness({ approvers: [APPROVER_ID] });
    await h.askToBeApprover();

    expect(
      await h.decisions.fromCommand(
        commandFrom("/approve", h.requestId(), { userId: APPROVER_ID }),
      ),
    ).toBe(COMMAND_REPLIES.adminOnly);
    await h.decisions.fromReaction(h.reaction("👍", { userId: APPROVER_ID }));

    expect(h.approverEntry()).toBeUndefined();
    expect(h.postToThread).not.toHaveBeenCalled();
  });

  it("refuses at approval time when the set filled up meanwhile, and releases the request", async () => {
    const h = await approverHarness();
    await h.askToBeApprover();
    h.setApprovers(Array.from({ length: MAX_APPROVERS }, (_, index) => `${8000 + index}`));

    const reply = await h.decisions.fromCommand(commandFrom("/approve", h.requestId()));

    expect(reply).toBe(COMMAND_REPLIES.approverCap);
    expect(h.approverEntry()).toBeUndefined();
    expect(h.postToThread).not.toHaveBeenCalled();
    h.setApprovers([]);

    await h.decisions.fromCommand(commandFrom("/approve", h.requestId()));
    expect(h.approverEntry()).toBeDefined();
  });

  it("words the denial verb without blocking", async () => {
    const h = await approverHarness();
    await h.askToBeApprover();

    expect(await h.decisions.fromCommand(commandFrom("/deny", h.requestId()))).toBe(
      `Denied approver ${h.requestId()}.`,
    );
  });
});
