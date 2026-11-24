import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FAILURE_NOTICE_MINUTES,
  readFailureNoticeIntervalMs,
} from "../src/lambda/dispatch-failure-notice.js";
import {
  MINUTE_MS,
  noticeHarness,
  SECRET_TEXT,
  SECRET_USER_ID,
} from "./helpers/dispatch-notice-fixtures.js";
import { GROUP_CHAT_ID, SLACK_BOT } from "./helpers/receiver-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatch failure notice", () => {
  it("DMs the admin once with the bot, platform, repository, status and hint, and rethrows", async () => {
    const h = await noticeHarness();
    h.failWith(404);

    await expect(h.dispatch()).rejects.toThrow(
      "repository_dispatch to octo/garden failed with HTTP 404",
    );

    expect(h.post).toHaveBeenCalledOnce();
    const text = h.noticeText();
    expect(text).toContain("Bot: garden");
    expect(text).toContain("Platform: telegram");
    expect(text).toContain("Repository: octo/garden");
    expect(text).toContain("HTTP status: 404");
    expect(text).toContain("token may lack access to that repository");
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the message text, sender and chat identifiers out of the DM and the logs", async () => {
    const h = await noticeHarness();
    h.failWith(404);

    await expect(h.handleMessage()).rejects.toThrow("HTTP 404");

    const sent = `${h.noticeText()}${JSON.stringify(h.logger.warn.mock.calls)}`;
    for (const secret of [
      SECRET_TEXT,
      SECRET_USER_ID,
      GROUP_CHAT_ID,
      "telegram:msg-42",
      "failed with",
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("sends one DM for a burst and another once the interval has passed", async () => {
    vi.useFakeTimers();
    const h = await noticeHarness();
    h.failWith(404);

    for (let i = 0; i < 5; i++) await expect(h.dispatch()).rejects.toThrow();
    expect(h.post).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(DEFAULT_FAILURE_NOTICE_MINUTES * MINUTE_MS + 1);
    await expect(h.dispatch()).rejects.toThrow();

    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("does not let one bot's notice suppress another's", async () => {
    const garden = await noticeHarness();
    const notes = await noticeHarness({ bot: SLACK_BOT });
    garden.failWith(404);
    notes.failWith(404);

    await expect(garden.dispatch()).rejects.toThrow();
    await expect(notes.dispatch()).rejects.toThrow();

    expect(garden.post).toHaveBeenCalledOnce();
    expect(notes.post).toHaveBeenCalledOnce();
    expect(notes.noticeText()).toContain("Platform: slack");
    expect(notes.noticeText()).toContain("Repository: octo/notes");
  });

  it("only rethrows when the platform has no admin", async () => {
    const h = await noticeHarness({ admin: null });
    h.failWith(404);

    await expect(h.dispatch()).rejects.toThrow("HTTP 404");

    expect(h.messenger.openDM).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("logs a failed notice with the bot and platform only, and rethrows the original error", async () => {
    const h = await noticeHarness({ dmFails: true });
    h.failWith(404);

    await expect(h.dispatch()).rejects.toThrow(
      "repository_dispatch to octo/garden failed with HTTP 404",
    );

    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to notify admin of dispatch failure",
      { bot: "garden", platform: "telegram" },
    );
    expect(h.messenger.openDM).toHaveBeenCalledOnce();
  });

  it("sends nothing when the dispatch succeeds", async () => {
    const h = await noticeHarness();

    await h.dispatch();

    expect(h.rawDispatcher.dispatch).toHaveBeenCalledOnce();
    expect(h.messenger.openDM).not.toHaveBeenCalled();
  });

  it.each([
    [404, "token may lack access"],
    [403, "token may lack access"],
    [401, "token may lack access"],
    [422, "Check the repository's centaur workflow."],
    [undefined, "Look at the receiver logs."],
  ])("gives the hint for status %s", async (status, hint) => {
    const h = await noticeHarness();
    h.failWith(status);

    await expect(h.dispatch()).rejects.toThrow();

    expect(h.noticeText()).toContain(hint);
    expect(h.noticeText().includes("HTTP status")).toBe(status !== undefined);
  });
});

describe("the configured notice interval", () => {
  it("sends nothing and writes no state when it is 0, and still rethrows", async () => {
    const h = await noticeHarness({ intervalMs: 0 });
    h.failWith(404);
    const setIfNotExists = vi.spyOn(h.state, "setIfNotExists");

    await expect(h.dispatch()).rejects.toThrow("HTTP 404");

    expect(h.messenger.openDM).not.toHaveBeenCalled();
    expect(setIfNotExists).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("honors a custom interval", async () => {
    vi.useFakeTimers();
    const h = await noticeHarness({ intervalMs: 5 * MINUTE_MS });
    h.failWith(404);

    await expect(h.dispatch()).rejects.toThrow();
    vi.advanceTimersByTime(4 * MINUTE_MS);
    await expect(h.dispatch()).rejects.toThrow();
    expect(h.post).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2 * MINUTE_MS);
    await expect(h.dispatch()).rejects.toThrow();
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{}, DEFAULT_FAILURE_NOTICE_MINUTES * MINUTE_MS],
    [{ DISPATCH_FAILURE_NOTICE_MINUTES: "" }, DEFAULT_FAILURE_NOTICE_MINUTES * MINUTE_MS],
    [{ DISPATCH_FAILURE_NOTICE_MINUTES: "0" }, 0],
    [{ DISPATCH_FAILURE_NOTICE_MINUTES: "1440" }, 1440 * MINUTE_MS],
  ])("reads %j from the environment", (env, expected) => {
    expect(readFailureNoticeIntervalMs(env)).toBe(expected);
  });

  it.each(["-1", "1441", "1.5", "soon"])("rejects %s like the history window does", (value) => {
    expect(() => readFailureNoticeIntervalMs({ DISPATCH_FAILURE_NOTICE_MINUTES: value })).toThrow(
      /invalid dispatch failure notice interval/,
    );
  });
});
