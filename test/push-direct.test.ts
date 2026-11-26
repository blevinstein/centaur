import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/workflows/aws.js";
import { isProtectedPath, pushDirect } from "../src/workflows/push-direct.js";
import { createClone, git } from "./helpers/git-fixtures.js";

const RUN_URL = "https://github.com/o/r/actions/runs/9";

const setup = async () => {
  const clone = await createClone();
  const push = (exec?: Exec) =>
    pushDirect({
      workspace: clone.work,
      defaultBranch: "main",
      message: "Add salad",
      runUrl: RUN_URL,
      tempDir: clone.base,
      exec,
    });
  const mainFile = (file: string) => clone.remoteFile(file, "main");
  const mainLog = () => clone.remoteLog("main");
  return { ...clone, push, mainFile, mainLog };
};

describe("pushDirect", () => {
  it("lands the changes on the default branch with a run-URL footer", async () => {
    const { work, write, push, advanceRemote, mainFile, mainLog, remote } = await setup();
    await advanceRemote("other.md", "elsewhere\n", "main");
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(push()).resolves.toMatchObject({ ok: true, commits: 1 });
    expect(await mainFile("plan.md")).toBe("tomatoes\nbasil\n");
    expect(await mainFile("other.md")).toBe("elsewhere\n");
    expect((await mainLog()).split("\n")[0]).toBe("Add salad|github-actions[bot]");
    expect(await git(remote, "log", "-1", "--format=%B", "main")).toContain(RUN_URL);
    expect(await git(remote, "log", "-1", "--format=%G?", "main")).toBe("N\n");
    expect(await readFile(join(work, "plan.md"), "utf8")).toBe("tomatoes\nbasil\n");
  });

  it("reports the pushed commit", async () => {
    const { write, push, remote } = await setup();
    await write("new.md", "hello\n");

    const result = await push();
    expect(result).toEqual({
      ok: true,
      commits: 1,
      sha: (await git(remote, "rev-parse", "main")).trim(),
    });
  });

  it("pushes nothing for an empty patch", async () => {
    const { push, mainLog } = await setup();
    const before = await mainLog();

    await expect(push()).resolves.toEqual({ ok: true, commits: 0 });
    expect(await mainLog()).toBe(before);
  });

  it("falls back on a conflict with the default branch", async () => {
    const { write, push, advanceRemote, mainLog } = await setup();
    await advanceRemote("plan.md", "potatoes\n", "main");
    const before = await mainLog();
    await write("plan.md", "peppers\n");

    await expect(push()).resolves.toEqual({ ok: false, reason: "conflict" });
    expect(await mainLog()).toBe(before);
  });

  it("retries once when the branch moved and then succeeds", async () => {
    const { write, push, raceFetches, mainFile } = await setup();
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(push(raceFetches("main", 1))).resolves.toMatchObject({ ok: true, commits: 1 });
    expect(await mainFile("plan.md")).toBe("tomatoes\nbasil\n");
    expect(await mainFile("race-0.md")).toBe("won\n");
  });

  it("falls back when the branch moves again on the retry", async () => {
    const { write, push, raceFetches, mainFile } = await setup();
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(push(raceFetches("main", 2))).resolves.toEqual({
      ok: false,
      reason: "push_rejected",
    });
    expect(await mainFile("plan.md")).toBe("tomatoes\n");
  });

  it("falls back when the remote rejects the push", async () => {
    const { write, push, rejectPushes, mainLog } = await setup();
    await rejectPushes();
    const before = await mainLog();
    await write("plan.md", "changed\n");

    await expect(push()).resolves.toEqual({ ok: false, reason: "push_rejected" });
    expect(await mainLog()).toBe(before);
  });

  it.each([".github/workflows/ci.yml", ".centaur.yml", "apps/x/.centaur/config.yml"])(
    "falls back without pushing when the diff touches %s",
    async (path) => {
      const { write, push, mainLog } = await setup();
      const before = await mainLog();
      await write("fine.md", "ok\n");
      await write(path, "x\n");

      await expect(push()).resolves.toEqual({ ok: false, reason: "protected_path" });
      expect(await mainLog()).toBe(before);
    },
  );

  it.each([
    [".github/workflows/ci.yml", true],
    [".github/actions/x/action.yml", true],
    [".github/CODEOWNERS", true],
    [".centaur.yml", true],
    [".centaur/config.yml", true],
    ["apps/x/.centaur/config.yml", true],
    ["apps/x/.centaur.yml", true],
    ["CODEOWNERS", true],
    ["docs/CODEOWNERS", true],
    [".GitHub/workflows/ci.yml", true],
    ["Apps/.Centaur/config.yml", true],
    ["codeowners", true],
    [".claude/settings.json", true],
    ["apps/x/.claude/skills/s/SKILL.md", true],
    [".claude-plugin/plugin.json", true],
    [".mcp.json", true],
    ["apps/x/.mcp.json", true],
    [".codex/config.toml", true],
    [".gemini/settings.json", true],
    [".cursor/rules/a.mdc", true],
    ["AGENTS.md", true],
    ["apps/x/CLAUDE.md", true],
    ["agents.md", true],
    [".gitmodules", true],
    ["notes/agents.md.txt", false],
    ["docs/claude.md.bak", false],
    ["docs/claude-notes.md", false],
    ["package.json", false],
    [".gitignore", false],
    ["src/a.ts", false],
    ["docs/github/readme.md", false],
    ["centaur.md", false],
    ["not.centaur/x", false],
  ])("isProtectedPath(%s) is %s", (path, expected) => {
    expect(isProtectedPath(path)).toBe(expected);
  });

  it("rejects an unsafe default branch name", async () => {
    const { work, base } = await setup();
    await expect(
      pushDirect({
        workspace: work,
        defaultBranch: "--upload-pack=x",
        message: "m",
        runUrl: RUN_URL,
        tempDir: base,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_ref" });
  });
});
