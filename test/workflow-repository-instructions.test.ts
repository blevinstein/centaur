import { describe, expect, it } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import {
  installedMemory,
  memoryOf,
  writeUserMemory,
} from "./helpers/repository-instructions-fixtures.js";
import { GARDEN, gardenSetup, setup, underFolder } from "./helpers/turn-fixtures.js";
import { configText, createWorkspace, message } from "./helpers/workflow-fixtures.js";

const OFF = "repository_instructions: {enabled: false}";
const WITH_REPO_ROOT = "repository_instructions: {include_repo_root: true}";

describe("prepare with repository instructions", () => {
  it("copies AGENTS.md into the user memory on a chat turn", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Use tabs." });

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf(["AGENTS.md", "Use tabs."]));
  });

  it("prefers AGENTS.md over CLAUDE.md and falls back to CLAUDE.md", async () => {
    const both = await setup([message("1", "hi")], configText(), {
      "AGENTS.md": "From agents.",
      "CLAUDE.md": "From claude.",
    });
    const only = await setup([message("1", "hi")], configText(), { "CLAUDE.md": "From claude." });

    await prepare(both.deps());
    await prepare(only.deps());

    expect(await installedMemory(both.home)).toBe(memoryOf(["AGENTS.md", "From agents."]));
    expect(await installedMemory(only.home)).toBe(memoryOf(["CLAUDE.md", "From claude."]));
  });

  it("installs only the sub-folder root's guide by default", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText(),
      { "AGENTS.md": "Garden." },
      { "AGENTS.md": "Repo." },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf([`${GARDEN}/AGENTS.md`, "Garden."]));
  });

  it("installs nothing for a sub-folder root without a guide, although the repository root has one", async () => {
    const run = await gardenSetup([message("1", "hi")], configText(), {}, { "AGENTS.md": "Repo." });

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("installs the repository-root guide first, then the sub-folder root's, with include_repo_root", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText(WITH_REPO_ROOT),
      { "AGENTS.md": "Garden." },
      { "AGENTS.md": "Repo." },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(
      memoryOf(["AGENTS.md", "Repo."], [`${GARDEN}/AGENTS.md`, "Garden."]),
    );
  });

  it("installs only the repository-root guide with include_repo_root when the sub-folder has none", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText(WITH_REPO_ROOT),
      {},
      { "CLAUDE.md": "Repo." },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(memoryOf(["CLAUDE.md", "Repo."]));
  });

  it("installs the repository guide once for a root at the repository top, whatever include_repo_root says", async () => {
    const off = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Repo." });
    const on = await setup([message("1", "hi")], configText(WITH_REPO_ROOT), {
      "AGENTS.md": "Repo.",
    });

    await prepare(off.deps());
    await prepare(on.deps());

    expect(await installedMemory(off.home)).toBe(memoryOf(["AGENTS.md", "Repo."]));
    expect(await installedMemory(on.home)).toBe(memoryOf(["AGENTS.md", "Repo."]));
  });

  it("prefers AGENTS.md over CLAUDE.md at each level", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText(WITH_REPO_ROOT),
      { "AGENTS.md": "Garden agents.", "CLAUDE.md": "Garden claude." },
      { "AGENTS.md": "Repo agents.", "CLAUDE.md": "Repo claude." },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(
      memoryOf(["AGENTS.md", "Repo agents."], [`${GARDEN}/AGENTS.md`, "Garden agents."]),
    );
  });

  it("installs nothing without a guide file", async () => {
    const run = await setup([message("1", "hi")]);

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("installs nothing when the key is off, and removes the file an earlier turn wrote", async () => {
    const run = await setup([message("1", "hi")], configText(OFF), { "AGENTS.md": "Use tabs." });
    await writeUserMemory(run.home, memoryOf(["AGENTS.md", "Stale."]));

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("replaces a stale file, and removes it once the guide is gone", async () => {
    const run = await setup([message("1", "hi")], configText(), { "AGENTS.md": "Fresh." });
    await writeUserMemory(run.home, memoryOf(["AGENTS.md", "Stale."]));
    await prepare(run.deps());
    expect(await installedMemory(run.home)).toBe(memoryOf(["AGENTS.md", "Fresh."]));

    const gone = await setup([message("1", "hi")]);
    await writeUserMemory(gone.home, memoryOf(["AGENTS.md", "Stale."]));
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

    expect(await installedMemory(run.home)).toBe(memoryOf(["AGENTS.md", "x".repeat(10)]));
  });

  it("applies max_bytes to both guides together, naming each file and size", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText("repository_instructions: {max_bytes: 10, include_repo_root: true}"),
      { "AGENTS.md": "y".repeat(5) },
      { "AGENTS.md": "x".repeat(6) },
    );

    await expect(prepare(run.deps())).rejects.toThrow(
      /AGENTS\.md is 6 bytes, apps\/garden\/AGENTS\.md is 5 bytes.*11 bytes together.*max_bytes \(10\)/,
    );
    expect(await installedMemory(run.home)).toBeUndefined();
  });

  it("accepts guides that together are exactly max_bytes", async () => {
    const run = await gardenSetup(
      [message("1", "hi")],
      configText("repository_instructions: {max_bytes: 10, include_repo_root: true}"),
      { "AGENTS.md": "y".repeat(5) },
      { "AGENTS.md": "x".repeat(5) },
    );

    await prepare(run.deps());

    expect(await installedMemory(run.home)).toBe(
      memoryOf(["AGENTS.md", "x".repeat(5)], [`${GARDEN}/AGENTS.md`, "y".repeat(5)]),
    );
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

    expect(await installedMemory(run.home)).toBe(memoryOf(["AGENTS.md", "Trusted rules."]));
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

  it("copies the trusted sub-folder guide alone by default, never the pull request branch's", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      files: { "AGENTS.md": "Branch repo.", [`${GARDEN}/AGENTS.md`]: "Branch garden." },
    });
    const trusted = await createWorkspace({
      ...underFolder({ ".centaur.yml": configText(), ".centaur/persona.md": "Be kind." }),
      "AGENTS.md": "Trusted repo.",
      [`${GARDEN}/AGENTS.md`]: "Trusted garden.",
    });

    await prepare({ ...run.deps(), configRoot: trusted.root, root: GARDEN });

    expect(await installedMemory(run.home)).toBe(
      memoryOf([`${GARDEN}/AGENTS.md`, "Trusted garden."]),
    );
  });

  it("copies both trusted guides for a sub-folder root with include_repo_root, never the pull request branch's", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      files: { "AGENTS.md": "Branch repo.", [`${GARDEN}/AGENTS.md`]: "Branch garden." },
    });
    const trusted = await createWorkspace({
      ...underFolder({
        ".centaur.yml": configText(WITH_REPO_ROOT),
        ".centaur/persona.md": "Be kind.",
      }),
      "AGENTS.md": "Trusted repo.",
      [`${GARDEN}/AGENTS.md`]: "Trusted garden.",
    });

    await prepare({ ...run.deps(), configRoot: trusted.root, root: GARDEN });

    expect(await installedMemory(run.home)).toBe(
      memoryOf(["AGENTS.md", "Trusted repo."], [`${GARDEN}/AGENTS.md`, "Trusted garden."]),
    );
  });
});
