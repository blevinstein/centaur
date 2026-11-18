import { describe, expect, it } from "vitest";
import { threadKey } from "../src/thread-key.js";

describe("threadKey", () => {
  it("is a stable 12-character hex string", () => {
    expect(threadKey("sprout", "telegram:-100:7")).toBe(threadKey("sprout", "telegram:-100:7"));
    expect(threadKey("sprout", "telegram:-100:7")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs per thread and per bot", () => {
    const keys = new Set([
      threadKey("sprout", "telegram:-100:7"),
      threadKey("sprout", "telegram:-100:8"),
      threadKey("garden", "telegram:-100:7"),
    ]);
    expect(keys.size).toBe(3);
  });

  it("does not run the bot and thread together ambiguously", () => {
    expect(threadKey("a", "b:c")).not.toBe(threadKey("a:b", "c"));
  });

  it("contains no part of the thread ID", () => {
    expect(threadKey("sprout", "telegram:-100123456789:7")).not.toMatch(/100123456789/);
  });
});
