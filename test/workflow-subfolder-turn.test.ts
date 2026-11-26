import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_FILE, prepare } from "../src/workflows/prepare.js";
import { CONSUMER_SKILL_PREFIX } from "../src/workflows/skills.js";
import { installedSkills, repositorySkill } from "./helpers/skill-fixtures.js";
import { GARDEN, gardenSetup, setup, underFolder } from "./helpers/turn-fixtures.js";
import { configText, createWorkspace, message } from "./helpers/workflow-fixtures.js";

const prompt = (root: string) => readFile(join(root, PROMPT_FILE), "utf8");
const WEEKLY = "prompts: {weekly: {context: fresh, destination: household}}";
const SCHEDULED = { promptName: "weekly", clientPayload: undefined };

describe("prepare with a Centaur root in a sub-folder", () => {
  it("reads the persona, the instructions override and the consumer skills from the root", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText("instructions:\n  chat: .centaur/chat.md"),
      {
        ".centaur/chat.md": "Garden chat rules.",

        ...repositorySkill("release"),
      },
    );

    const out = await prepare(run.deps());

    expect(out.claude_args).toContain(`--append-system-prompt-file ${GARDEN}/.centaur/persona.md`);
    expect(await prompt(run.root)).toContain("Garden chat rules.");
    expect(await installedSkills(run.home)).toEqual([`${CONSUMER_SKILL_PREFIX}release`]);
  });

  it("reads a scheduled prompt file from the root", async () => {
    const run = await gardenSetup([], configText(WEEKLY, "{ respond_to: all }"), {
      ".centaur/prompts/weekly.md": "Water the garden.",
    });

    await prepare(run.deps(SCHEDULED));

    expect(await prompt(run.root)).toContain("Water the garden.");
  });

  it("names the project folder and the guide files that exist", async () => {
    const run = await gardenSetup([message("1", "hi")], configText(), { "CLAUDE.md": "Notes." });

    await prepare(run.deps());

    const text = await prompt(run.root);
    expect(text).toContain(`# Project folder\n\nYour project folder is \`${GARDEN}\``);
    expect(text).toContain(`Read \`${GARDEN}/CLAUDE.md\` first.`);
    expect(text).not.toContain("AGENTS.md");
  });

  it("omits the guide instruction when the folder has no guide file", async () => {
    const run = await gardenSetup([message("1", "hi")]);

    await prepare(run.deps());

    expect(await prompt(run.root)).not.toContain("first.");
  });

  it("reads the config, persona and guide from the config root of a comment-style turn", async () => {
    const run = await gardenSetup([message("1", "hi")], configText("model: opus"));
    const trusted = await createWorkspace(
      underFolder({
        ".centaur.yml": configText(),
        ".centaur/persona.md": "Trusted.",
        "AGENTS.md": "Trusted guide.",
      }),
    );

    const out = await prepare(run.deps({ configRoot: trusted.root }));

    expect(out.claude_args).toContain("--model sonnet");
    expect(out.claude_args).toContain(
      `--append-system-prompt-file ${join(trusted.root, GARDEN, ".centaur/persona.md")}`,
    );
    expect(await prompt(run.root)).toContain(`${GARDEN}/AGENTS.md`);
  });

  it("rejects a repo that also has a config at its top", async () => {
    const run = await gardenSetup([message("1", "hi")]);
    const { root } = await createWorkspace({
      ...underFolder({ ".centaur.yml": configText() }),
      ".centaur.yml": configText(),
    });

    await expect(prepare({ ...run.deps(), workspace: root })).rejects.toThrow(
      /repo root .* and in a sub-folder/,
    );
  });
});

describe("prepare with the default root", () => {
  it("adds no project folder section", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Notes." });

    await prepare(run.deps({ root: "." }));

    expect(await prompt(run.root)).not.toContain("Project folder");
  });
});
