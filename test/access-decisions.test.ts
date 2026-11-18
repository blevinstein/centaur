import { describe, expect, it, vi } from "vitest";
import { APPROVED_TEXT, COMMAND_REPLIES } from "../src/lambda/access-decisions.js";
import { ADMIN_ID, accessHarness } from "./helpers/access-fixtures.js";
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
      const approved = h.params.values[`/centaur/bots/garden/approved-${kind}s/${id}`] as string;
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
      expect(h.params.values[`/centaur/bots/garden/blocked/${kind}/${id}`]).toBeDefined();
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

    expect(h.params.values["/centaur/bots/garden/approved-users/9999"]).toBeUndefined();
    expect(h.invalidateAccess).not.toHaveBeenCalled();
    expect(h.postToThread).not.toHaveBeenCalled();
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
    expect(h.params.values["/centaur/bots/garden/blocked/user/9999"]).toBeUndefined();
  });

  it("ignores an expired request", async () => {
    vi.useFakeTimers();
    try {
      const h = await pendingRequest("user", { limits: { ttlMs: 1000 } });
      vi.advanceTimersByTime(1001);

      await h.decisions.fromReaction(h.reaction("👍"));

      expect(h.params.values["/centaur/bots/garden/approved-users/9999"]).toBeUndefined();
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

    expect(h.params.values["/centaur/bots/garden/approved-users/9999"]).toBeDefined();
  });

  it("still records the approval when the confirmation cannot be posted", async () => {
    const h = await pendingRequest("user");
    h.postToThread.mockRejectedValueOnce(new Error("blocked by user"));

    await h.decisions.fromReaction(h.reaction("👍"));

    expect(h.params.values["/centaur/bots/garden/approved-users/9999"]).toBeDefined();
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

    expect(approveReply).toBe(`Approved chat ${approved.requestId()}.`);
    expect(approved.params.values["/centaur/bots/garden/approved-chats/-100500"]).toBeDefined();
    expect(denyReply).toContain("Denied and blocked user");
    expect(denied.params.values["/centaur/bots/garden/blocked/user/9999"]).toBeDefined();
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

  it.each([
    ["a non-admin", { userId: STRANGER_USER_ID }, "/approve"],
    ["outside a direct message", { isDM: false }, "/approve"],
    ["another command", {}, "/start"],
  ])("ignores a command from %s", async (_name, overrides, name) => {
    const h = await pendingRequest("user");

    expect(await h.decisions.fromCommand(command(name, h.requestId(), overrides))).toBeUndefined();

    expect(h.params.values["/centaur/bots/garden/approved-users/9999"]).toBeUndefined();
  });
});
