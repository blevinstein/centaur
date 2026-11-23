import { describe, expect, it, vi } from "vitest";
import { APPROVED_TEXT, COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import { ADMIN_ID, accessHarness } from "./helpers/access-fixtures.js";
import { destinationAt } from "./helpers/destination-fixtures.js";
import {
  fakeMessage,
  fakeThread,
  GROUP_CHAT_ID,
  GROUP_CHAT_TITLE,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";

async function pendingRequest(
  kind: "chat" | "user",
  options: Parameters<typeof accessHarness>[0] = {},
) {
  const h = await accessHarness(options);
  const { thread } = fakeThread();
  await h.requestAccess(kind, thread, fakeMessage({ userId: STRANGER_USER_ID, isMention: true }));
  return h;
}

const subjects = {
  chat: { id: GROUP_CHAT_ID, name: GROUP_CHAT_TITLE },
  user: { id: STRANGER_USER_ID, name: "Pat Example" },
} as const;

const command = (
  name: string,
  text: string,
  overrides: { userId?: string; isDM?: boolean } = {},
) => ({
  command: name,
  text,
  user: { userId: overrides.userId ?? ADMIN_ID },
  isDM: overrides.isDM ?? true,
});

describe("access decisions by reaction", () => {
  it.each(["chat", "user"] as const)(
    "approves a %s with a thumbs-up and confirms to the requester",
    async (kind) => {
      const h = await pendingRequest(kind);

      await h.decisions.fromReaction(h.reaction("👍"));

      const { id, name } = subjects[kind];
      const approved = h.params.values[
        `/centaur/bots/garden/platforms/telegram/approved-${kind}s/${id}`
      ] as string;
      expect(JSON.parse(approved)).toMatchObject({ name });
      expect(h.invalidateAccess).toHaveBeenCalledOnce();
      expect(h.postToThread).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("telegram:"),
        APPROVED_TEXT[kind],
      );
    },
  );

  it.each(["chat", "user"] as const)(
    "denies and blocks a %s with a thumbs-down, silently",
    async (kind) => {
      const h = await pendingRequest(kind);

      await h.decisions.fromReaction(h.reaction("👎"));

      const { id } = subjects[kind];
      expect(
        h.params.values[`/centaur/bots/garden/platforms/telegram/blocked/${kind}/${id}`],
      ).toBeDefined();
      expect(Object.keys(h.params.values).some((name) => name.includes("/approved-"))).toBe(false);
      expect(h.postToThread).not.toHaveBeenCalled();
      expect(h.invalidateAccess).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["a reaction by someone other than the admin", { userId: STRANGER_USER_ID }, "👍"],
    ["a reaction on a different message", { messageId: "telegram:5001:901" }, "👍"],
    ["a removed reaction", { added: false }, "👍"],
    ["a reaction outside a direct message", { isDM: false }, "👍"],
    ["an unrelated emoji", {}, "❤"],
  ])("ignores %s", async (_name, overrides, emoji) => {
    const h = await pendingRequest("user");

    await h.decisions.fromReaction(h.reaction(emoji, overrides));

    expect(
      h.params.values["/centaur/bots/garden/platforms/telegram/approved-users/9999"],
    ).toBeUndefined();
    expect(h.invalidateAccess).not.toHaveBeenCalled();
    expect(h.postToThread).not.toHaveBeenCalled();
  });

  it.each([
    ["outside a direct message", { isDM: false }, "outside a direct message"],
    ["on a message with no linked request", { messageId: "other" }, "no linked request"],
  ])("logs a reaction ignored %s", async (_name, overrides, reason) => {
    const h = await pendingRequest("user");

    await h.decisions.fromReaction(h.reaction("👍", overrides));

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(reason),
      expect.objectContaining({ bot: "garden", userId: ADMIN_ID }),
    );
  });

  it("warns by ID when a non-admin reacts to a request message", async () => {
    const h = await pendingRequest("user");

    await h.decisions.fromReaction(h.reaction("👍", { userId: STRANGER_USER_ID }));

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("non-admin"),
      expect.objectContaining({ userId: STRANGER_USER_ID }),
    );
  });

  it("treats a request as single-use: a second reaction changes nothing", async () => {
    const h = await pendingRequest("user");

    await h.decisions.fromReaction(h.reaction("👍"));
    await h.decisions.fromReaction(h.reaction("👎"));
    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.postToThread).toHaveBeenCalledOnce();
    expect(h.invalidateAccess).toHaveBeenCalledOnce();
    expect(
      h.params.values["/centaur/bots/garden/platforms/telegram/blocked/user/9999"],
    ).toBeUndefined();
  });

  it("ignores an expired request", async () => {
    vi.useFakeTimers();
    try {
      const h = await pendingRequest("user", { limits: { ttlMs: 1000 } });
      vi.advanceTimersByTime(1001);

      await h.decisions.fromReaction(h.reaction("👍"));

      expect(
        h.params.values["/centaur/bots/garden/platforms/telegram/approved-users/9999"],
      ).toBeUndefined();
      expect(h.postToThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the request when storing the decision fails, so it can be retried", async () => {
    const h = await pendingRequest("user");
    const failing = vi.spyOn(h.params, "put").mockRejectedValueOnce(new Error("throttled"));

    await expect(h.decisions.fromReaction(h.reaction("👍"))).rejects.toThrow("throttled");
    failing.mockRestore();
    await h.decisions.fromReaction(h.reaction("👍"));

    expect(
      h.params.values["/centaur/bots/garden/platforms/telegram/approved-users/9999"],
    ).toBeDefined();
  });

  it("still records the approval when the confirmation cannot be posted", async () => {
    const h = await pendingRequest("user");
    h.postToThread.mockRejectedValueOnce(new Error("blocked by user"));

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(
      h.params.values["/centaur/bots/garden/platforms/telegram/approved-users/9999"],
    ).toBeDefined();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("confirm approval"),
      expect.anything(),
    );
  });

  it("does nothing when no admin is configured", async () => {
    const h = await pendingRequest("user");
    delete h.params.values["/centaur/admin/telegram"];

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.invalidateAccess).not.toHaveBeenCalled();
  });
});

describe("access decisions by command", () => {
  it("approves and denies by request ID, case-insensitively", async () => {
    const approved = await pendingRequest("chat");
    const denied = await pendingRequest("user");

    const approveReply = await approved.decisions.fromCommand(
      command("/approve", ` ${approved.requestId().toUpperCase()} `),
    );
    const denyReply = await denied.decisions.fromCommand(command("/deny", denied.requestId()));

    expect(approveReply).toBe(`Approved chat ${approved.requestId()} as "garden-club".`);
    expect(
      approved.params.values["/centaur/bots/garden/platforms/telegram/approved-chats/-100500"],
    ).toBeDefined();
    expect(denyReply).toContain("Denied and blocked user");
    expect(
      denied.params.values["/centaur/bots/garden/platforms/telegram/blocked/user/9999"],
    ).toBeDefined();
  });

  it("answers repeats, unknown IDs and missing IDs", async () => {
    const h = await pendingRequest("user");
    await h.decisions.fromCommand(command("/approve", h.requestId()));

    expect(await h.decisions.fromCommand(command("/deny", h.requestId()))).toBe(
      COMMAND_REPLIES.handled,
    );
    expect(await h.decisions.fromCommand(command("/approve", "nope"))).toBe(
      COMMAND_REPLIES.unknown,
    );
    expect(await h.decisions.fromCommand(command("/approve", "  "))).toBe(COMMAND_REPLIES.usage);
  });

  it("leaves a request raised on another platform's connection unknown and unapproved", async () => {
    const h = await accessHarness();
    const request = await h.store.create({
      kind: "user",
      subjectId: "USLACKUSER",
      subjectName: "Pat Example",
      threadId: "slack:C0CLNRASDJ4:1699999999.000100",
    });

    expect(await h.decisions.fromCommand(command("/approve", request.id))).toBe(
      COMMAND_REPLIES.unknown,
    );
    expect(Object.keys(h.params.values).filter((name) => name.includes("USLACKUSER"))).toEqual([]);
  });

  it.each([
    ["a non-admin", { userId: STRANGER_USER_ID }, "/approve"],
    ["outside a direct message", { isDM: false }, "/approve"],
    ["another command", {}, "/start"],
  ])("ignores a command from %s", async (_name, overrides, name) => {
    const h = await pendingRequest("user");

    expect(await h.decisions.fromCommand(command(name, h.requestId(), overrides))).toBeUndefined();

    expect(
      h.params.values["/centaur/bots/garden/platforms/telegram/approved-users/9999"],
    ).toBeUndefined();
  });
});

describe("destinations on approval", () => {
  const GARDEN_CLUB = "garden-club";
  const GARDEN_CLUB_PARAMETER = `/centaur/chats/telegram/${GARDEN_CLUB}`;
  const stored = (h: Awaited<ReturnType<typeof pendingRequest>>, name = GARDEN_CLUB) =>
    destinationAt(h.params, "telegram", name);
  const approvedEntry = (h: Awaited<ReturnType<typeof pendingRequest>>) =>
    JSON.parse(
      h.params.values[
        `/centaur/bots/garden/platforms/telegram/approved-chats/${GROUP_CHAT_ID}`
      ] as string,
    );

  it("records the proposed name as a destination and on the approved entry", async () => {
    const h = await pendingRequest("chat");

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(stored(h)).toMatchObject({ chatId: GROUP_CHAT_ID, name: GROUP_CHAT_TITLE });
    expect(approvedEntry(h)).toMatchObject({ name: GROUP_CHAT_TITLE, alias: GARDEN_CLUB });
  });

  it("never overwrites a destination that appeared after the request, taking the next free name", async () => {
    const h = await pendingRequest("chat");
    h.params.values[GARDEN_CLUB_PARAMETER] = "-1";

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.params.values[GARDEN_CLUB_PARAMETER]).toBe("-1");
    expect(stored(h, "garden-club-2").chatId).toBe(GROUP_CHAT_ID);
    expect(approvedEntry(h)).toMatchObject({ alias: `${GARDEN_CLUB}-2` });
  });

  it("takes the plain name when another platform already uses it", async () => {
    const h = await pendingRequest("chat");
    h.params.values["/centaur/chats/slack/garden-club"] = "C1";

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(stored(h)).toMatchObject({ chatId: GROUP_CHAT_ID, name: GROUP_CHAT_TITLE });
    expect(h.params.values["/centaur/chats/slack/garden-club"]).toBe("C1");
  });

  it("keeps a destination that already holds the chat", async () => {
    const h = await pendingRequest("chat");
    h.params.values[GARDEN_CLUB_PARAMETER] = GROUP_CHAT_ID;

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(Object.keys(h.params.values).filter((name) => name.includes("garden-club"))).toEqual([
      GARDEN_CLUB_PARAMETER,
    ]);
    expect(approvedEntry(h)).toMatchObject({ alias: GARDEN_CLUB });
  });

  it("derives a name from the chat ID for a request stored without one", async () => {
    const h = await accessHarness();
    const request = await h.store.create({
      kind: "chat",
      subjectId: GROUP_CHAT_ID,
      subjectName: GROUP_CHAT_TITLE,
      threadId: "telegram:-100500:7",
    });

    const reply = await h.decisions.fromCommand(command("/approve", request.id));

    expect(reply).toBe(COMMAND_REPLIES.approve(request, "chat-0500"));
    expect(stored(h, "chat-0500").chatId).toBe(GROUP_CHAT_ID);
  });

  it.each([
    ["a denied chat", "chat", "👎"],
    ["an approved user", "user", "👍"],
  ] as const)("creates no destination for %s", async (_name, kind, emoji) => {
    const h = await pendingRequest(kind);

    await h.decisions.fromReaction(h.reaction(emoji));

    expect(
      Object.keys(h.params.values).filter((name) => name.startsWith("/centaur/chats/")),
    ).toEqual([]);
  });

  it("stores no half-done approval when the destination cannot be recorded", async () => {
    const h = await pendingRequest("chat");
    vi.spyOn(h.params, "putIfAbsent").mockRejectedValueOnce(new Error("throttled"));

    await expect(h.decisions.fromReaction(h.reaction("👍"))).rejects.toThrow("throttled");

    expect(
      h.params.values[`/centaur/bots/garden/platforms/telegram/approved-chats/${GROUP_CHAT_ID}`],
    ).toBeUndefined();
    await h.decisions.fromReaction(h.reaction("👍"));
    expect(approvedEntry(h)).toMatchObject({ alias: GARDEN_CLUB });
  });
});
