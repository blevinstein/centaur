import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_SKILL_PREFIX, installSkills } from "../src/workflows/skills.js";
import {
  BUILT_IN_FILES,
  consumerSkill,
  fileTree,
  installedSkills,
  rejectedConsumerSkills,
  skillText,
  withSymlink,
} from "./helpers/skill-fixtures.js";

const newHome = () => mkdtemp(join(tmpdir(), "centaur-home-"));
const skillPath = (home: string, ...parts: string[]) => join(home, ".claude", "skills", ...parts);

describe("installSkills", () => {
  it("copies each built-in skill folder with its files", async () => {
    const home = await newHome();

    await installSkills({ home, sourceDir: await fileTree(BUILT_IN_FILES) });

    expect(await installedSkills(home)).toEqual(["centaur-alpha", "centaur-beta"]);
    expect(await readFile(skillPath(home, "centaur-alpha", "reference", "detail.md"), "utf8")).toBe(
      "Detail.\n",
    );
  });

  it("removes stale centaur-* folders and leaves other skills alone", async () => {
    const home = await newHome();
    await installSkills({
      home,
      sourceDir: await fileTree({ "centaur-old/SKILL.md": skillText("centaur-old") }),
    });
    await writeFile(skillPath(home, "mine.md"), "mine");

    await installSkills({ home, sourceDir: await fileTree(BUILT_IN_FILES) });

    expect(await installedSkills(home)).toEqual(["centaur-alpha", "centaur-beta", "mine.md"]);
  });

  it("installs nothing but still removes stale folders when the built-ins are off", async () => {
    const home = await newHome();
    await installSkills({ home, sourceDir: await fileTree(BUILT_IN_FILES) });

    await installSkills({ home, sourceDir: undefined });

    expect(await installedSkills(home)).toEqual([]);
  });

  it("copies consumer skills under the consumer prefix, after validating them", async () => {
    const home = await newHome();
    const consumerDir = await fileTree({
      ...consumerSkill("release", { "allowed-tools": "Read Bash(git log *)" }),
      "release/notes.md": "Notes.\n",
    });

    await installSkills({
      home,
      sourceDir: await fileTree(BUILT_IN_FILES),
      consumerDir,
      allowedTools: ["Read", "Bash(git log *)"],
    });

    expect(await installedSkills(home)).toEqual([
      "centaur-alpha",
      "centaur-beta",
      `${CONSUMER_SKILL_PREFIX}release`,
    ]);
    expect(
      await readFile(skillPath(home, `${CONSUMER_SKILL_PREFIX}release`, "notes.md"), "utf8"),
    ).toBe("Notes.\n");
  });

  it("does nothing for a consumer directory that does not exist", async () => {
    const home = await newHome();

    await installSkills({
      home,
      sourceDir: await fileTree(BUILT_IN_FILES),
      consumerDir: join(await newHome(), "none"),
    });

    expect(await installedSkills(home)).toEqual(["centaur-alpha", "centaur-beta"]);
  });

  it.each(rejectedConsumerSkills)(
    "fails the turn for a consumer skill with %s",
    async (_name, files, allowedTools, message) => {
      const home = await newHome();

      await expect(
        installSkills({
          home,
          sourceDir: await fileTree(BUILT_IN_FILES),
          consumerDir: await fileTree(files),
          allowedTools,
        }),
      ).rejects.toThrow(message);
    },
  );

  it("fails the turn for a symlink inside a consumer skill", async () => {
    const consumerDir = await withSymlink(
      await fileTree(consumerSkill("deploy")),
      "deploy/secrets",
      "/etc",
    );

    await expect(
      installSkills({ home: await newHome(), sourceDir: undefined, consumerDir }),
    ).rejects.toThrow(/skill "deploy".*symbolic link/);
  });

  it("never lets a same-named consumer skill replace a built-in", async () => {
    const home = await newHome();

    await expect(
      installSkills({
        home,
        sourceDir: await fileTree(BUILT_IN_FILES),
        consumerDir: await fileTree(consumerSkill("centaur-alpha")),
      }),
    ).rejects.toThrow(/reserved/);

    expect(await readFile(skillPath(home, "centaur-alpha", "SKILL.md"), "utf8")).toContain(
      "Body of centaur-alpha.",
    );
  });
});
