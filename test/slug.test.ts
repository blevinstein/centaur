import { expect, test } from "vitest";
import { slugify } from "../src/slug.js";

test("slugify collapses punctuation and trims separators", () => {
  expect(slugify("  Hello, World! ")).toBe("hello-world");
});
