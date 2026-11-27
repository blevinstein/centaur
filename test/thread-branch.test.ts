import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushExisting } from "../src/workflows/push-existing.js";
import { checkoutBranch, startFromThreadBranch } from "../src/workflows/thread-branch.js";
import { createClone, git } from "./helpers/git-fixtures.js";
import { candidatePr, targetSetup } from "./helpers/pr-target-fixtures.js";

const BRANCH = candidatePr(5).headRef;

const setup = async (options: { open?: boolean; hostile?: boolean } = {}) => {
  const clone = await createClone();
  await git(clone.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
  await clone.advanceRemote("turn-one.md", "first turn\n", BRANCH);
  await git(clone.work, "switch", "--detach", "origin/main");
  const marker = options.hostile ? await clone.plantHostileConfig() : undefined;
  const { candidateDeps } = targetSetup({ open: options.open === false ? [] : [candidatePr(5)] });
  const start = () =>
    startFromThreadBranch(candidateDeps, {
      workspace: clone.work,
      stateDir: clone.base,
      branch: BRANCH,
      configRoot: undefined,
    });
  return { ...clone, start, marker, candidateDeps };
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("startFromThreadBranch", () => {
  it("starts the workspace from the tip of the thread branch with its upstream set", async () => {
    const { work, start } = await setup();

    const started = await start();

    expect(started).toEqual({ number: 5, headRef: BRANCH, configRoot: expect.any(String) });
    expect(await readFile(join(work, "turn-one.md"), "utf8")).toBe("first turn\n");
    expect((await git(work, "branch", "--show-current")).trim()).toBe(BRANCH);
    expect((await git(work, "rev-parse", "--abbrev-ref", "@{upstream}")).trim()).toBe(
      `origin/${BRANCH}`,
    );
  });

  it("keeps the default branch's files as the config root", async () => {
    const { work, base, start } = await setup();

    const started = await start();

    expect(started?.configRoot).toBe(join(base, "trusted"));
    expect(await exists(join(base, "trusted", "plan.md"))).toBe(true);
    expect(await exists(join(base, "trusted", "turn-one.md"))).toBe(false);
    expect(await exists(join(work, "turn-one.md"))).toBe(true);
  });

  it("leaves the workspace on the default branch when no pull request is open on the branch", async () => {
    const { work, start } = await setup({ open: false });
    const before = (await git(work, "rev-parse", "HEAD")).trim();

    await expect(start()).resolves.toBeUndefined();
    expect((await git(work, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await exists(join(work, "turn-one.md"))).toBe(false);
  });

  it("adds the next turn's changes on top of the earlier turn without force", async () => {
    const { work, base, start, write, remoteFiles, remoteLog } = await setup();
    await start();
    await write("turn-two.md", "second turn\n");

    await expect(
      pushExisting({
        workspace: work,
        headRef: BRANCH,
        number: 5,
        pullRequestUrl: "https://github.com/o/r/pull/5",
        message: "Second turn",
        tempDir: base,
      }),
    ).resolves.toMatchObject({ ok: true, commits: 1 });

    expect(await remoteFiles(BRANCH)).toEqual(["plan.md", "turn-one.md", "turn-two.md"]);
    expect((await remoteLog(BRANCH)).split("\n").slice(0, 2)).toEqual([
      "Second turn|github-actions[bot]",
      "remote change|t",
    ]);
  });

  it("does not run hooks or config the workspace planted", async () => {
    const { start, marker } = await setup({ hostile: true });

    await start();

    expect(await exists(marker as string)).toBe(false);
  });

  it("fails rather than fall back when the branch cannot be fetched", async () => {
    const { work, base } = await setup();

    await expect(
      checkoutBranch({
        workspace: work,
        stateDir: base,
        branch: "centaur/missing",
        configRoot: undefined,
      }),
    ).rejects.toThrow();
  });

  it("refuses a branch that is not a safe centaur branch", async () => {
    const { work, base } = await setup();

    await expect(
      checkoutBranch({ workspace: work, stateDir: base, branch: "main", configRoot: undefined }),
    ).rejects.toThrow("invalid branch");
  });

  it("reuses a supplied config root instead of making a copy", async () => {
    const { work, base } = await setup();

    await expect(
      checkoutBranch({ workspace: work, stateDir: base, branch: BRANCH, configRoot: "/trusted" }),
    ).resolves.toBe("/trusted");
    expect(await exists(join(base, "trusted"))).toBe(false);
  });
});
