import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_MAX_MESSAGES_LIMIT,
  HISTORY_TTL_DAYS_LIMIT,
  readHistoryWindow,
} from "../src/lambda/history-window.js";
import { HISTORY_ENV, historyAppendOptions } from "./helpers/history-fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => vi.unstubAllGlobals());

describe("readHistoryWindow", () => {
  it("defaults to the Chat SDK's 100 messages and 7 days", () => {
    expect(readHistoryWindow({})).toEqual({ maxMessages: 100, ttlMs: 7 * DAY_MS });
    expect(readHistoryWindow({})).toEqual(DEFAULT_HISTORY_WINDOW);
    expect(readHistoryWindow(HISTORY_ENV)).toEqual(DEFAULT_HISTORY_WINDOW);
    expect(readHistoryWindow({ HISTORY_MAX_MESSAGES: "", HISTORY_TTL_DAYS: "" })).toEqual(
      DEFAULT_HISTORY_WINDOW,
    );
  });

  it("reads both settings from the environment", () => {
    expect(readHistoryWindow({ HISTORY_MAX_MESSAGES: "500", HISTORY_TTL_DAYS: "14" })).toEqual({
      maxMessages: 500,
      ttlMs: 14 * DAY_MS,
    });
  });

  it("accepts the upper bounds", () => {
    expect(
      readHistoryWindow({
        HISTORY_MAX_MESSAGES: String(HISTORY_MAX_MESSAGES_LIMIT),
        HISTORY_TTL_DAYS: String(HISTORY_TTL_DAYS_LIMIT),
      }),
    ).toEqual({ maxMessages: HISTORY_MAX_MESSAGES_LIMIT, ttlMs: HISTORY_TTL_DAYS_LIMIT * DAY_MS });
  });

  it.each([
    ["zero messages", { HISTORY_MAX_MESSAGES: "0" }, /HISTORY_MAX_MESSAGES must be at least 1/],
    [
      "negative messages",
      { HISTORY_MAX_MESSAGES: "-5" },
      /HISTORY_MAX_MESSAGES must be at least 1/,
    ],
    [
      "fractional messages",
      { HISTORY_MAX_MESSAGES: "1.5" },
      /HISTORY_MAX_MESSAGES must be an integer/,
    ],
    [
      "non-numeric messages",
      { HISTORY_MAX_MESSAGES: "lots" },
      /HISTORY_MAX_MESSAGES must be a number/,
    ],
    [
      "too many messages",
      { HISTORY_MAX_MESSAGES: "5001" },
      /HISTORY_MAX_MESSAGES must be at most 5000/,
    ],
    ["zero days", { HISTORY_TTL_DAYS: "0" }, /HISTORY_TTL_DAYS must be at least 1/],
    ["too many days", { HISTORY_TTL_DAYS: "366" }, /HISTORY_TTL_DAYS must be at most 365/],
  ])("fails fast on %s", (_name, env, message) => {
    expect(() => readHistoryWindow(env)).toThrow(message);
  });
});

describe("the Chat history wiring", () => {
  it("stores with the SDK defaults when no window is given", async () => {
    const { status, options } = await historyAppendOptions();
    expect(status).toBe(200);
    expect(options).toContainEqual({ maxLength: 100, ttlMs: 7 * DAY_MS });
  });

  it("stores every list with the configured window", async () => {
    const { options } = await historyAppendOptions({ maxMessages: 500, ttlMs: 14 * DAY_MS });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option).toEqual({ maxLength: 500, ttlMs: 14 * DAY_MS });
  });
});
