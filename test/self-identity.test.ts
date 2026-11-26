import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_TIMEOUT_MS,
  IDENTITY_TTL_MS,
  withSelfIdentity,
} from "../src/lambda/self-identity.js";
import { MAX_IDENTITY_LENGTH, selfIdentitySchema, toSelfIdentity } from "../src/self-identity.js";
import { fakeDispatcher, GARDEN_BOT, SLACK_BOT } from "./helpers/receiver-fixtures.js";
import {
  fakeSlackAdapter,
  fakeTelegramAdapter,
  fakeTelegramMe,
  GARDEN_IDENTITY,
  HOSTILE_NAME,
  lookupWith,
} from "./helpers/self-identity-fixtures.js";

afterEach(() => vi.useRealTimers());

describe("the Telegram identity", () => {
  it("is the user name and the full name from getMe", async () => {
    const { lookup } = lookupWith();

    expect(await lookup(GARDEN_BOT, fakeTelegramAdapter())).toEqual(GARDEN_IDENTITY);
  });

  it("uses the first name alone when there is no last name", async () => {
    const { lookup } = lookupWith(fakeTelegramMe({ username: "garden_bot", first_name: "Garden" }));

    expect((await lookup(GARDEN_BOT, fakeTelegramAdapter()))?.display_name).toBe("Garden");
  });

  it("falls back to the adapter user name when getMe fails, and asks again next time", async () => {
    const { lookup, getMe } = lookupWith(fakeTelegramMe(new Error("down")));

    const expected = { username: "garden_bot", display_name: "garden_bot" };
    expect(await lookup(GARDEN_BOT, fakeTelegramAdapter())).toEqual(expected);
    expect(await lookup(GARDEN_BOT, fakeTelegramAdapter())).toEqual(expected);
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it("gives no identity when nothing usable is known", async () => {
    const { lookup } = lookupWith(fakeTelegramMe(new Error("down")));

    expect(await lookup(GARDEN_BOT, fakeTelegramAdapter("`\n"))).toBeUndefined();
  });

  it("reads getMe once per bot until the cache expires, which picks up a rename", async () => {
    vi.useFakeTimers();
    const { lookup, getMe } = lookupWith();
    const adapter = fakeTelegramAdapter();

    await lookup(GARDEN_BOT, adapter);
    await lookup(GARDEN_BOT, adapter);
    expect(getMe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IDENTITY_TTL_MS + 1);
    await lookup(GARDEN_BOT, adapter);
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it("does not wait longer than the timeout", async () => {
    vi.useFakeTimers();
    const { lookup } = lookupWith(vi.fn(() => new Promise(() => {})));

    const pending = lookup(GARDEN_BOT, fakeTelegramAdapter());
    await vi.advanceTimersByTimeAsync(IDENTITY_TIMEOUT_MS + 1);

    expect(await pending).toEqual({ username: "garden_bot", display_name: "garden_bot" });
  });
});

describe("the Slack identity", () => {
  it.each([
    ["the display name", { profile: { display_name: "Notes", real_name: "Real" } }, "Notes"],
    ["the profile real name", { profile: { display_name: "", real_name: "Real" } }, "Real"],
    ["the user real name", { real_name: "Top Real" }, "Top Real"],
    ["the user name", {}, "notes_bot"],
  ])("prefers %s", async (_label, user, displayName) => {
    const { adapter, info } = fakeSlackAdapter(user);

    expect(await lookupWith().lookup(SLACK_BOT, adapter)).toEqual({
      username: "notes_bot",
      display_name: displayName,
    });
    expect(info).toHaveBeenCalledWith({ user: "UBOT" });
  });

  it("falls back to the user name when users.info fails", async () => {
    const { adapter } = fakeSlackAdapter(new Error("missing_scope"));

    expect(await lookupWith().lookup(SLACK_BOT, adapter)).toEqual({
      username: "notes_bot",
      display_name: "notes_bot",
    });
  });

  it("reads users.info once per bot", async () => {
    const { adapter, info } = fakeSlackAdapter({ profile: { display_name: "Notes" } });
    const { lookup } = lookupWith();

    await lookup(SLACK_BOT, adapter);
    await lookup(SLACK_BOT, adapter);

    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("the dispatch payload", () => {
  const payload = { bot: "garden", thread_id: "t" };

  it("carries the identity next to the existing fields", async () => {
    const inner = fakeDispatcher();

    await withSelfIdentity(inner, async () => GARDEN_IDENTITY).dispatch("o/r", "e", payload);

    expect(inner.dispatch).toHaveBeenCalledWith("o/r", "e", { ...payload, self: GARDEN_IDENTITY });
  });

  it("is unchanged when no identity is known", async () => {
    const inner = fakeDispatcher();

    await withSelfIdentity(inner, async () => undefined).dispatch("o/r", "e", payload);

    expect(inner.dispatch).toHaveBeenCalledWith("o/r", "e", payload);
  });
});

describe("sanitizing names", () => {
  it("reduces a hostile display name to one short line without markup", () => {
    const identity = toSelfIdentity("garden_bot", HOSTILE_NAME);

    expect(identity?.display_name).not.toMatch(/[\n\r`"\\<>[\]]/);
    expect(identity?.display_name).not.toContain("\u0000");
    expect(identity?.display_name.length).toBeLessThanOrEqual(MAX_IDENTITY_LENGTH);
    expect(identity?.display_name).toMatch(/^Evil # Instructions/);
  });

  it("drops an identity whose username is empty after cleaning", () => {
    expect(toSelfIdentity("\n`", "Garden")).toBeUndefined();
  });

  it("cleans a payload the runner parses", () => {
    expect(
      selfIdentitySchema.parse({ username: "garden_bot", display_name: HOSTILE_NAME }).display_name,
    ).not.toContain("\n");
  });
});
