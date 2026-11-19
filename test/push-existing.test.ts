import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Exec, execCommand } from "../src/workflows/aws.js";
import { isValidHeadRef, pushExisting } from "../src/workflows/push-existing.js";
import { createClone, git } from "./helpers/git-fixtures.js";

const HEAD_REF = "centaur/branch";

const setup = async (options: { ignoreTurnDir?: boolean } = {}) => {
  const clone = await createClone(options);
  const push = (exec?: Exec) =>
    pushExisting({
      workspace: clone.work,
      headRef: HEAD_REF,
      number: 7,
      pullRequestUrl: "https://github.com/o/r/pull/7",
      message: "Add salad",
      tempDir: clone.base,
      exec,
    });
  return { ...clone, push };
};

describe("pushExisting", () => {
  it("applies the workspace changes on top of the remote branch", async () => {
    const { write, push, advanceRemote, remoteFile, remoteLog } = await setup();
    await advanceRemote("other.md", "elsewhere\n");
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(push()).resolves.toEqual({
      ok: true,
      commits: 1,
      url: "https://github.com/o/r/pull/7",
      number: 7,
    });
    expect(await remoteFile("plan.md")).toBe("tomatoes\nbasil\n");
    expect(await remoteFile("other.md")).toBe("elsewhere\n");
    expect((await remoteLog()).split("\n")[0]).toBe("Add salad|github-actions[bot]");
  });

  it("reports no changes for an empty patch", async () => {
    const { push, remoteLog } = await setup();
    const before = await remoteLog();

    await expect(push()).resolves.toEqual({ ok: true, commits: 0 });
    expect(await remoteLog()).toBe(before);
  });

  it("never commits .centaur-turn or .centaur-trusted, excluded or not", async () => {
    for (const ignoreTurnDir of [true, false]) {
      const { write, push, remoteFiles } = await setup({ ignoreTurnDir });
      await write(".centaur-turn/prompt.md", "secret\n");
      await write(".centaur-trusted/config.yml", "secret\n");
      await write("new.md", "hello\n");

      await expect(push()).resolves.toMatchObject({ ok: true, commits: 1 });
      expect(await remoteFiles()).toEqual(["new.md", "plan.md"]);
    }
  });

  it("falls back with conflict and leaves the workspace as the agent left it", async () => {
    const { work, write, push, advanceRemote, remoteLog } = await setup();
    await advanceRemote("plan.md", "potatoes\n");
    const before = await remoteLog();
    await write("plan.md", "peppers\n");
    await write("extra.md", "more\n");

    await expect(push()).resolves.toEqual({ ok: false, reason: "conflict" });
    expect(await readFile(join(work, "plan.md"), "utf8")).toBe("peppers\n");
    expect(await readFile(join(work, "extra.md"), "utf8")).toBe("more\n");
    expect(await remoteLog()).toBe(before);
    expect(await git(work, "worktree", "list", "--porcelain")).not.toContain("centaur-push-");
  });

  it("falls back when the push is not a fast-forward", async () => {
    const { work, write, push, advanceRemote, remoteFile } = await setup();
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(
      push(async (file, args) => {
        const out = await execCommand(file, args);
        if (args.includes("fetch")) await advanceRemote("race.md", "won\n");
        return out;
      }),
    ).resolves.toEqual({ ok: false, reason: "push_rejected" });
    expect(await readFile(join(work, "plan.md"), "utf8")).toBe("tomatoes\nbasil\n");
    expect(await remoteFile("plan.md")).toBe("tomatoes\n");
  });

  it("falls back when the branch cannot be fetched", async () => {
    const { work, base, write } = await setup();
    await write("plan.md", "changed\n");

    await expect(
      pushExisting({
        workspace: work,
        headRef: "centaur/missing",
        number: 7,
        pullRequestUrl: "u",
        message: "m",
        tempDir: base,
      }),
    ).resolves.toEqual({ ok: false, reason: "fetch_failed" });
  });

  it("rejects unsafe head refs before running git", async () => {
    for (const ref of ["main", "centaur/../x", "centaur/a b", "centaur/-x\n", "centaur/x;rm"]) {
      expect(isValidHeadRef(ref)).toBe(false);
    }
    expect(isValidHeadRef("centaur/bot-abc123")).toBe(true);
    const { work, base } = await setup();
    await expect(
      pushExisting({
        workspace: work,
        headRef: "--upload-pack=x",
        number: 1,
        pullRequestUrl: "u",
        message: "m",
        tempDir: base,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_ref" });
  });
});
