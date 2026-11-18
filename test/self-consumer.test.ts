import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCentaurConfig } from "../src/config/index.js";

describe("this repo's .centaur.yml", () => {
  it("parses and points at files that exist", () => {
    const result = parseCentaurConfig(readFileSync(".centaur.yml", "utf8"));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const files = [result.config.persona, result.config.prompts.hello?.file ?? ""];
    expect(files[1]).toBe(".centaur/prompts/hello.md");
    for (const file of files) expect(readFileSync(file, "utf8")).not.toBe("");
  });
});
