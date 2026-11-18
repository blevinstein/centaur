import { describe, expect, it, vi } from "vitest";
import { PENDING_TEXT, REQUESTED_TEXT, UNREACHABLE_TEXT } from "../src/lambda/access-requests.js";
import { ADMIN_DM_MESSAGE_ID, accessHarness } from "./helpers/access-fixtures.js";
import {
  fakeMessage,
  fakeThread,
  GROUP_CHAT_ID,
  GROUP_CHAT_TITLE,
  MESSAGE_TEXT,
  STRANGER_USER_ID,
} from "./helpers/receiver-fixtures.js";

const strangerMessage = () => fakeMessage({ userId: STRANGER_USER_ID, isMention: true });

describe("access requester", () => {
  it.each([
    ["chat", GROUP_CHAT_ID, GROUP_CHAT_TITLE],
    ["user", STRANGER_USER_ID, "Pat Example"],
  ] as const)(
    "notifies the admin of a %s request and tells the requester",
    async (kind, subjectId, subjectName) => {
      const h = await accessHarness();
      const { thread, post } = fakeThread();

      expect(await h.requestAccess(kind, thread, strangerMessage())).toBe(true);

      expect(h.messenger.openDM).toHaveBeenCalledExactlyOnceWith("5001");
      const text = h.adminText();
      expect(text).toContain(`Access request ${h.requestId()}`);
      expect(text).toContain("Bot: garden");
      expect(text).toContain(`Kind: ${kind}`);
      expect(text).toContain(`Requester: Pat Example (${STRANGER_USER_ID})`);
      expect(text).toContain(`Chat: ${GROUP_CHAT_TITLE} (${GROUP_CHAT_ID})`);
      expect(text).toContain("👍");
      expect(text).toContain("👎");
      expect(text).toContain(`/approve ${h.requestId()}`);
      expect(text).not.toContain(MESSAGE_TEXT);
      expect(post).toHaveBeenCalledExactlyOnceWith(REQUESTED_TEXT);
      expect(await h.store.read(h.requestId())).toMatchObject({ kind, subjectId, subjectName });
      expect(await h.store.requestIdForMessage(ADMIN_DM_MESSAGE_ID)).toBe(h.requestId());
    },
  );

  it("describes a direct message request without a chat title", async () => {
    const h = await accessHarness();

    await h.requestAccess(
      "user",
      fakeThread({ isDM: true, chatId: STRANGER_USER_ID }).thread,
      strangerMessage(),
    );

    expect(h.adminText()).toContain(`Chat: direct message (${STRANGER_USER_ID})`);
  });

  it("declines to handle the request when no admin is configured", async () => {
    const h = await accessHarness({ admin: null });
    const { thread, post } = fakeThread();

    expect(await h.requestAccess("user", thread, strangerMessage())).toBe(false);

    expect(h.messenger.openDM).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not notify again while a request for the same subject is pending", async () => {
    const h = await accessHarness();
    const first = fakeThread();
    const second = fakeThread();

    await h.requestAccess("chat", first.thread, strangerMessage());
    await h.requestAccess("chat", second.thread, fakeMessage({ isMention: true }));

    expect(h.adminPost).toHaveBeenCalledOnce();
    expect(second.post).toHaveBeenCalledExactlyOnceWith(PENDING_TEXT);

    const third = fakeThread();
    await h.requestAccess("chat", third.thread, fakeMessage({ isMention: true }));
    expect(h.adminPost).toHaveBeenCalledOnce();
    expect(third.post).not.toHaveBeenCalled();
  });

  it("tracks chat and user requests as separate subjects", async () => {
    const h = await accessHarness();
    const { thread } = fakeThread();

    await h.requestAccess("chat", thread, strangerMessage());
    await h.requestAccess("user", thread, strangerMessage());

    expect(h.adminPost).toHaveBeenCalledTimes(2);
  });

  it("silently drops requests over the hourly cap and logs at info", async () => {
    const h = await accessHarness({ limits: { perHour: 2 } });
    const fresh = fakeThread({ chatId: "-100999" });

    await h.requestAccess(
      "user",
      fakeThread().thread,
      fakeMessage({ userId: "1", isMention: true }),
    );
    await h.requestAccess(
      "user",
      fakeThread().thread,
      fakeMessage({ userId: "2", isMention: true }),
    );
    expect(
      await h.requestAccess("user", fresh.thread, fakeMessage({ userId: "3", isMention: true })),
    ).toBe(true);

    expect(h.adminPost).toHaveBeenCalledTimes(2);
    expect(fresh.post).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("limit"),
      expect.objectContaining({ subjectId: "3" }),
    );
  });

  it("frees the hourly cap and the subject slot as time passes", async () => {
    vi.useFakeTimers();
    try {
      const h = await accessHarness({ limits: { perHour: 1, ttlMs: 2 * 60 * 60 * 1000 } });
      await h.requestAccess("user", fakeThread().thread, strangerMessage());
      vi.advanceTimersByTime(61 * 60 * 1000);

      await h.requestAccess(
        "user",
        fakeThread().thread,
        fakeMessage({ userId: "2", isMention: true }),
      );

      expect(h.adminPost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a subject ask again after its request expires", async () => {
    vi.useFakeTimers();
    try {
      const h = await accessHarness({ limits: { ttlMs: 1000 } });
      await h.requestAccess("user", fakeThread().thread, strangerMessage());
      const firstId = h.requestId();
      vi.advanceTimersByTime(1001);

      expect(await h.store.read(firstId)).toBeNull();
      await h.requestAccess("user", fakeThread().thread, strangerMessage());

      expect(h.adminPost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the requester only that the admin is unreachable when the DM fails", async () => {
    const h = await accessHarness({ dmFails: true });
    const { thread, post } = fakeThread();

    expect(await h.requestAccess("chat", thread, strangerMessage())).toBe(true);

    expect(post).toHaveBeenCalledExactlyOnceWith(UNREACHABLE_TEXT);
    expect(JSON.stringify(post.mock.calls)).not.toContain("5001");
    expect(JSON.stringify(post.mock.calls)).not.toContain("chat not found");
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("notify admin"),
      expect.objectContaining({ subjectId: GROUP_CHAT_ID }),
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(MESSAGE_TEXT);
  });

  it("allows another attempt after a failed notification", async () => {
    const h = await accessHarness({ dmFails: true });
    await h.requestAccess("chat", fakeThread().thread, strangerMessage());
    const retry = fakeThread();

    await h.requestAccess("chat", retry.thread, strangerMessage());

    expect(retry.post).toHaveBeenCalledExactlyOnceWith(UNREACHABLE_TEXT);
    expect(h.messenger.openDM).toHaveBeenCalledTimes(2);
  });

  it("issues distinct, case-insensitive request IDs", async () => {
    const h = await accessHarness();
    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      h.adminPost.mockClear();
      await h.requestAccess(
        "user",
        fakeThread().thread,
        fakeMessage({ userId: `u${i}`, isMention: true }),
      );
      ids.add(h.requestId());
    }

    expect(ids.size).toBe(8);
    const [id] = [...ids] as [string];
    expect(await h.store.read(id.toUpperCase())).toMatchObject({ id });
  });
});
