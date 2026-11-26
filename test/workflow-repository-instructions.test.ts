import { describe, expect, it } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  installedMemory,
  memoryOf,
  writeUserMemory,
} from "./helpers/repository-instructions-fixtures.js";
import { gardenSetup, setup } from "./helpers/turn-fixtures.js";
import { configText, createWorkspace, message } from "./helpers/workflow-fixtures.js";

const OFF = "repository_instructions: {enabled: false}";

describe("prepare with repository instructions", () => {
  it("copies AGENTS.md into the user memory on a chat turn", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Use tabs." });

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf("Use tabs."));
  });

  it("prefers AGENTS.md over CLAUDE.md and falls back to CLAUDE.md", async () => {
    const both = await setup([message("1", "hi")], configText(), {
      "AGENTS.md": "From agents.",
      "CLAUDE.md": "From claude.",
    });
    const only = await setup([message("1", "hi")], configText(), { "CLAUDE.md": "From claude." });

    await prepare(both.deps());
    await prepare(only.deps());

    expect(await installedMemory(both.home)).toBe(memoryOf("From agents."));
    expect(await installedMemory(only.home)).toBe(memoryOf("From claude."));
  });

  it("reads the guide from the Centaur root in a sub-folder, not the repository root", async () => {
    const run = await gardenSetup([message("1", "hi")], configText(), { "AGENTS.md": "Garden." });

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf("Garden."));
  });

  it("installs nothing without a guide file", async () => {
    const run = await setup([message("1", "hi")]);

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("installs nothing when the key is off, and removes the file an earlier turn wrote", async () => {
    const run = await setup([message("1", "hi")], configText(OFF), { "AGENTS.md": "Use tabs." });
    await writeUserMemory(run.home, memoryOf("Stale."));

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("replaces a stale file, and removes it once the guide is gone", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Fresh." });
    await writeUserMemory(run.home, memoryOf("Stale."));
    await prepare(run.deps());
    expect(await installedMemory(run.home)).toBe(memoryOf("Fresh."));

    const gone = await setup([message("1", "hi")]);
    await writeUserMemory(gone.home, memoryOf("Stale."));
    await prepare(gone.deps());

    expect(await installedMemory(gone.home)).toBeUndefined();
  });

  it("fails the turn for a guide over max_bytes instead of truncating it", async () => {
    const run = await setup(
      [message("1", "hi")],
      configText("repository_instructions: {max_bytes: 10}"),
      { "AGENTS.md": "x".repeat(11) },
    );

    await expect(prepare(run.deps())).rejects.toThrow(/AGENTS\.md is 11 bytes.*max_bytes \(10\)/);
    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("accepts a guide of exactly max_bytes", async () => {
    const run = await setup(
      [message("1", "hi")],
      configText("repository_instructions: {max_bytes: 10}"),
      { "AGENTS.md": "x".repeat(10) },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf("x".repeat(10)));
  });

  it("never overwrites a user memory Centaur did not write", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Use tabs." });
    await writeUserMemory(run.home, "Mine.");

    await expect(prepare(run.deps())).rejects.toThrow(/not written by Centaur/);
    expect(await installedMemory(run.home)).toBe("Mine.");
  });

  it("leaves a user memory Centaur did not write alone when the key is off", async () => {
    const run = await setup([message("1", "hi")], configText(OFF), { "AGENTS.md": "Use tabs." });
    await writeUserMemory(run.home, "Mine.");

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe("Mine.");
  });
});

describe("prepare with repository instructions on a comment turn", () => {
  it("copies the trusted checkout's guide, never the pull request branch's", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      files: { "AGENTS.md": "Branch rules.", "CLAUDE.md": "Branch claude." },
    });
    const trusted = await createWorkspace({
      ".centaur.yml": configText(),
      ".centaur/persona.md": "Be kind.",
      "AGENTS.md": "Trusted rules.",
    });

    await prepare({ ...run.deps(), configRoot: trusted.root });

    expect(await installedMemory(run.home)).toBe(memoryOf("Trusted rules."));
  });

  it("installs nothing when only the pull request branch has a guide", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      files: { "AGENTS.md": "Branch rules." },
    });
    const trusted = await createWorkspace({
      ".centaur.yml": configText(),
      ".centaur/persona.md": "Be kind.",
    });

    await prepare({ ...run.deps(), configRoot: trusted.root });

    expect(await installedMemory(run.home)).toBeUndefined();
  });
});
