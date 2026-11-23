import { describe, expect, it } from "vitest";
import { splitTextMaxChars } from "../src/workflows/split-text.js";

describe("splitTextMaxChars", () => {
  it.each([
    ["short text is unchanged", "hello", 10, ["hello"]],
    ["text exactly at the limit is unchanged", "hello", 5, ["hello"]],
    ["the empty string", "", 5, [""]],
    ["newlines are tried first", "aaa\nbbb\nccc", 7, ["aaa\nbbb", "ccc"]],
    [
      "sentence ends are tried before whitespace",
      "One two. Three four.",
      10,
      ["One two.", "Three", "four."],
    ],
    ["whitespace is the last resort", "aa bb cc dd", 5, ["aa\nbb", "cc\ndd"]],
    ["a part exactly at the limit", "abcde\nfghij", 5, ["abcde", "fghij"]],
    [
      "a word longer than the limit is cut by characters",
      "see https://example.com/very/long/path ok",
      10,
      ["see", "https://ex", "ample.com/", "very/long/", "path\nok"],
    ],
  ])("%s", (_name, text, maxChars, chunks) => {
    expect(splitTextMaxChars(text, maxChars)).toEqual(chunks);
  });

  it("keeps every chunk within the limit and the first chunk in order", () => {
    const text = `${"word ".repeat(200)}${"x".repeat(300)}\n${"Sentence one. ".repeat(50)}`;

    const chunks = splitTextMaxChars(text, 40);

    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 40)).toBe(true);
    expect(chunks[0]).toBe("word\nword\nword\nword\nword\nword\nword\nword");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the limit %s", (maxChars) => {
    expect(() => splitTextMaxChars("text", maxChars)).toThrow(/positive integer/);
  });
});
