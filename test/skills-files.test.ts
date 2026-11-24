import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_DESCRIPTION_MAX, skillFrontmatter } from "../src/workflows/skills.js";

const names = readdirSync("skills", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("the built-in skills", () => {
  it("ships at least one skill, all named centaur-*", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^centaur-(?!consumer-)[a-z0-9-]+$/);
  });

  it.each(names)("%s has only a name and a discoverable description", (name) => {
    const frontmatter = skillFrontmatter(readFileSync(`skills/${name}/SKILL.md`, "utf8"));

    expect(Object.keys(frontmatter).toSorted()).toEqual(["description", "name"]);
    expect(frontmatter.name).toBe(name);
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
    expect(String(frontmatter.description).length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
  });
});
