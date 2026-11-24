import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_FILE, prepare } from "../src/workflows/prepare.js";
import { CONSUMER_SKILL_PREFIX } from "../src/workflows/skills.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  BUILT_IN_FILES,
  fileTree,
  installedSkills,
  repositorySkill,
} from "./helpers/skill-fixtures.js";
import { setup } from "./helpers/turn-fixtures.js";
import { configText, createWorkspace, message } from "./helpers/workflow-fixtures.js";

const BUILT_INS = ["centaur-alpha", "centaur-beta"];
const BOTH_OFF = "skills: {builtin: false, consumer: false}";

describe("prepare with skills", () => {
  it("installs the built-ins and the workspace's consumer skills, and allows the Skill tool", async () => {
    const run = await setup([message("1", "hi")], configText(), repositorySkill("release"));

    const out = await prepare(run.deps({ skillsDir: await fileTree(BUILT_IN_FILES) }));

    expect(await installedSkills(run.home)).toEqual([
      ...BUILT_INS,
      `${CONSUMER_SKILL_PREFIX}release`,
    ]);
    expect(out.claude_args).toContain('--allowedTools "Read,Edit,Skill"');
  });

  it("installs only the built-ins when consumer skills are off", async () => {
    const run = await setup(
      [message("1", "hi")],
      configText("skills: {consumer: false}"),
      repositorySkill("release"),
    );

    await prepare(run.deps({ skillsDir: await fileTree(BUILT_IN_FILES) }));

    expect(await installedSkills(run.home)).toEqual(BUILT_INS);
  });

  it("tells the agent about the built-in skills only when they are on", async () => {
    const on = await setup([message("1", "hi")]);
    const off = await setup([message("1", "hi")], configText("skills: {builtin: false}"));

    await prepare(on.deps({ skillsDir: await fileTree(BUILT_IN_FILES) }));
    await prepare(off.deps({ skillsDir: await fileTree(BUILT_IN_FILES) }));

    expect(await readFile(join(on.root, PROMPT_FILE), "utf8")).toContain("`centaur-*` skills");
    expect(await readFile(join(off.root, PROMPT_FILE), "utf8")).not.toContain("`centaur-*` skills");
    expect(await installedSkills(off.home)).toEqual([]);
  });

  it("leaves Skill out and installs nothing when both sets are off", async () => {
    const run = await setup([message("1", "hi")], configText(BOTH_OFF), repositorySkill("release"));

    const out = await prepare(run.deps({ skillsDir: await fileTree(BUILT_IN_FILES) }));

    expect(out.claude_args).not.toContain("Skill");
    expect(await installedSkills(run.home)).toEqual([]);
  });

  it("fails the turn naming a consumer skill that widens the allowed tools", async () => {
    const run = await setup(
      [message("1", "hi")],
      configText(),
      repositorySkill("deploy", { "allowed-tools": "Bash" }),
    );

    await expect(prepare(run.deps())).rejects.toThrow(/skill "deploy".*Bash/);
  });

  it("passes no setting sources on a chat turn", async () => {
    const run = await setup([message("1", "hi")]);

    expect((await prepare(run.deps())).claude_args).not.toContain("--setting-sources");
  });
});

describe("prepare with skills on a comment turn", () => {
  it("restricts the setting sources to user, leaving the branch's project and local settings unloaded", async () => {
    const { deps } = await commentSetup({ comments: [prComment(1, "rename it")] });

    const { claude_args } = await prepare(deps());

    expect(claude_args).toMatch(/--setting-sources user(?= |$)/);
    expect(claude_args).not.toContain("local");
  });

  it("copies consumer skills from the trusted checkout, never from the pull request branch", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      files: repositorySkill("branch-only"),
    });
    const trusted = await createWorkspace({
      ".centaur.yml": configText(),
      ".centaur/persona.md": "Be kind.",
      ...repositorySkill("release"),
    });

    await prepare({
      ...run.deps(),
      configRoot: trusted.root,
      skillsDir: await fileTree(BUILT_IN_FILES),
    });

    expect(await installedSkills(run.home)).toEqual([
      ...BUILT_INS,
      `${CONSUMER_SKILL_PREFIX}release`,
    ]);
  });
});
