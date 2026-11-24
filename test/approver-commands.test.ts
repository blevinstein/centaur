import { describe, expect, it } from "vitest";
import { COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import {
  APPROVER_REPLIES,
  parseApproverCommand,
  readApproverCommand,
} from "../src/lambda/approver-commands.js";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import {
  ADMIN_ID,
  APPROVER_ID,
  APPROVER_ROUTES,
  approverHarness,
  approverKeys,
  asAdmin,
  commandFrom,
  OTHER_APPROVER_ID,
  REQUESTER_ID,
  REQUESTER_THREAD_ID,
  SLACK_ADMIN_ID,
  slackApproverHarness,
  viaDirectMessage,
  viaSlashCommand,
} from "./helpers/access-fixtures.js";

describe("parseApproverCommand", () => {
  it.each([
    ["approver request", "request"],
    ["  Approver   LEAVE ", "leave"],
    ["approver list", "list"],
    ["approver add 1", "add"],
    ["approver remove <@U1>", "remove"],
  ])("parses %j", (text, sub) => {
    expect(parseApproverCommand(text)).toBe(sub);
  });

  it.each([
    ["approver add 6001", { sub: "add", target: "6001" }],
    ["approver add", { sub: "add", target: undefined }],
    ["approver remove <@U1|pat>", { sub: "remove", target: "<@U1|pat>" }],
  ])("reads the target of %j", (text, command) => {
    expect(readApproverCommand(text)).toEqual(command);
  });

  it.each([
    "approver",
    "approver list 1",
    "approver add 1 2",
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

const FULL_SET = Array.from({ length: MAX_APPROVERS }, (_, index) => `${8000 + index}`);

describe.each(APPROVER_ROUTES)("admin approver commands through %s", (_route, via) => {
  it("adds by numeric ID, recording the admin and the time, and tells nobody else", async () => {
    const h = await approverHarness();

    const { posts } = await via(h, "add 6001", asAdmin);

    expect(posts).toEqual(["Added 6001 as an approver."]);
    expect(JSON.parse(h.approverEntry("6001") ?? "")).toEqual({
      approver: ADMIN_ID,
      at: expect.any(String),
    });
    expect(h.messenger.openDM).not.toHaveBeenCalled();
    expect(h.postToThread).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing approver", async () => {
    const h = await approverHarness({ approvers: [APPROVER_ID] });

    const { posts } = await via(h, `add ${APPROVER_ID}`, asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.alreadyListed]);
    expect(JSON.parse(h.approverEntry(APPROVER_ID) ?? "")).not.toHaveProperty("approver");
  });

  it("refuses the admin's own ID", async () => {
    const h = await approverHarness();

    const { posts } = await via(h, `add ${ADMIN_ID}`, asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.adminTarget]);
    expect(approverKeys(h)).toEqual([]);
  });

  it("refuses over the cap", async () => {
    const h = await approverHarness({ approvers: FULL_SET });

    const { posts } = await via(h, "add 6001", asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.full]);
    expect(h.approverEntry("6001")).toBeUndefined();
  });

  it.each(["../x", "a/b", "1.5", "abc", "6001/../x", "<@../x>", "12345678901234567890"])(
    "refuses the ID %j and writes nothing",
    async (target) => {
      const h = await approverHarness();

      const { posts } = await via(h, `add ${target}`, asAdmin);

      expect(posts).toEqual([APPROVER_REPLIES.invalidId]);
      expect(approverKeys(h)).toEqual([]);
    },
  );

  it("asks for a target when there is none", async () => {
    const h = await approverHarness();

    const { posts } = await via(h, "add", asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.noTarget]);
  });

  it("refuses a bare username with a hint", async () => {
    const h = await approverHarness();

    const { posts } = await via(h, "add @pat", asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.usernameTarget]);
    expect(approverKeys(h)).toEqual([]);
  });

  it("removes an approver and keeps the others", async () => {
    const h = await approverHarness({ approvers: ["6001", OTHER_APPROVER_ID] });

    const { posts } = await via(h, "remove 6001", asAdmin);

    expect(posts).toEqual(["Removed 6001 as an approver."]);
    expect(h.approverEntry("6001")).toBeUndefined();
    expect(h.approverEntry(OTHER_APPROVER_ID)).toBeDefined();
  });

  it("says so when the ID to remove is not an approver, and deletes nothing", async () => {
    const h = await approverHarness({ approvers: [APPROVER_ID] });

    const { posts } = await via(h, "remove 6009", asAdmin);

    expect(posts).toEqual([APPROVER_REPLIES.notListed]);
    expect(approverKeys(h)).toHaveLength(1);
  });

  it("lists nobody when the set is empty", async () => {
    const h = await approverHarness();

    expect((await via(h, "list", asAdmin)).posts).toEqual([APPROVER_REPLIES.noApprovers]);
  });

  it("lists the approvers in order with when and by whom they were added", async () => {
    const h = await approverHarness({ approvers: [OTHER_APPROVER_ID] });
    await via(h, "add 6001", asAdmin);

    const { posts } = await via(h, "list", asAdmin);

    expect(posts[0]).toMatch(
      /^Approvers \(you, the admin, are always one\):\n6001, added \S+ by 5001\n6002, added \S+$/,
    );
  });

  it("tells an approver that only the admin can", async () => {
    const h = await approverHarness({ approvers: [APPROVER_ID] });

    for (const text of ["add 6001", "remove 6001", "list"]) {
      expect((await via(h, text, { userId: APPROVER_ID })).posts).toEqual([
        APPROVER_REPLIES.adminOnly,
      ]);
    }
    expect(approverKeys(h)).toHaveLength(1);
  });

  it.each(["approved", "stranger"] as const)(
    "falls through for a %s user, so they are never told the commands exist",
    async (standing) => {
      const h = await approverHarness({ standing });

      for (const text of ["add 6001", "remove 6001", "list"]) {
        const { posts, fellThrough } = await via(h, text);
        expect(fellThrough).toBe(true);
        expect(posts.join(" ")).not.toMatch(/approver/i);
      }
      expect(approverKeys(h)).toEqual([]);
    },
  );

  it("is not available without an admin on the platform", async () => {
    const h = await approverHarness({ admin: null });

    expect(await via(h, "add 6001")).toEqual({ posts: [], fellThrough: true });
    expect(approverKeys(h)).toEqual([]);
  });

  it.each(["add 6001", "remove 6001", "list"])(
    "refuses %j outside a direct message",
    async (text) => {
      const h = await approverHarness({ approvers: ["6001"] });

      const { posts } = await via(h, text, { ...asAdmin, isDM: false });

      expect(posts).toEqual([APPROVER_REPLIES.notDirect]);
      expect(approverKeys(h)).toHaveLength(1);
    },
  );
});

describe("admin approver commands as a Telegram reply", () => {
  it("adds the author of the replied-to message and confirms their name", async () => {
    const h = await approverHarness();

    const { posts } = await viaSlashCommand(h, "add", {
      ...asAdmin,
      replyTo: { id: 6001, firstName: "Sam" },
    });

    expect(posts).toEqual(["Added Sam (6001) as an approver."]);
    expect(JSON.parse(h.approverEntry("6001") ?? "")).toEqual({
      name: "Sam",
      approver: ADMIN_ID,
      at: expect.any(String),
    });
  });

  it("answers with a fixed line in a group, where only a reply is accepted", async () => {
    const h = await approverHarness();
    const inGroup = { ...asAdmin, isDM: false, replyTo: { id: 6001, firstName: "Sam" } };

    expect((await viaSlashCommand(h, "add", inGroup)).posts).toEqual([APPROVER_REPLIES.added]);
    expect(h.approverEntry("6001")).toBeDefined();
    expect((await viaSlashCommand(h, "remove", inGroup)).posts).toEqual([APPROVER_REPLIES.removed]);
    expect(h.approverEntry("6001")).toBeUndefined();
    expect((await viaSlashCommand(h, "add 6001", { ...inGroup })).posts).toEqual([
      APPROVER_REPLIES.notDirect,
    ]);
  });

  it("refuses a bot account", async () => {
    const h = await approverHarness();

    const { posts } = await viaSlashCommand(h, "add", {
      ...asAdmin,
      replyTo: { id: 6001, isBot: true },
    });

    expect(posts).toEqual([APPROVER_REPLIES.botTarget]);
    expect(approverKeys(h)).toEqual([]);
  });

  it("prefers a named ID over the replied-to author", async () => {
    const h = await approverHarness();

    await viaSlashCommand(h, "add 6003", { ...asAdmin, replyTo: { id: 6001 } });

    expect(approverKeys(h)).toEqual([expect.stringMatching(/\/6003$/)]);
  });
});

describe("admin approver commands on Slack", () => {
  it.each([
    ["a user ID", "add U0PAT1", "U0PAT1"],
    ["a workspace-wide ID", "add W0PAT1", "W0PAT1"],
    ["a mention", "add <@U0PAT1>", "U0PAT1"],
    ["a mention with a name", "add <@U0PAT1|pat>", "U0PAT1"],
  ])("adds by %s from the raw text", async (_name, text, userId) => {
    const h = await slackApproverHarness();

    const { posts } = await viaDirectMessage(h, text, { userId: SLACK_ADMIN_ID });

    expect(posts).toEqual([`Added ${userId} as an approver.`]);
    expect(JSON.parse(h.approverEntry(userId) ?? "")).toEqual({
      approver: SLACK_ADMIN_ID,
      at: expect.any(String),
    });
  });

  it("removes by mention", async () => {
    const h = await slackApproverHarness({ approvers: ["U0PAT1"] });

    const { posts } = await viaDirectMessage(h, "remove <@U0PAT1>", { userId: SLACK_ADMIN_ID });

    expect(posts).toEqual(["Removed U0PAT1 as an approver."]);
    expect(h.approverEntry("U0PAT1")).toBeUndefined();
  });

  it.each(["6001", "u0pat1", "U0/../x", "<@U0PAT1/x>", "@pat"])(
    "refuses %j and writes nothing",
    async (target) => {
      const h = await slackApproverHarness();

      const { posts } = await viaDirectMessage(h, `add ${target}`, { userId: SLACK_ADMIN_ID });

      expect(posts).toEqual([
        target === "@pat" ? APPROVER_REPLIES.usernameTarget : APPROVER_REPLIES.invalidId,
      ]);
      expect(approverKeys(h)).toEqual([]);
    },
  );
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
