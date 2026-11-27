import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pushChanges, pushNewBranch } from "../src/workflows/push.js";
import { pushExisting } from "../src/workflows/push-existing.js";
import { createClone, git } from "./helpers/git-fixtures.js";

const ranScripts = (marker: string) => readFile(marker, "utf8").catch(() => "");

describe("push steps with a workspace the agent configured", () => {
  it("runs no planted hook, fsmonitor, ssh command or credential helper in pushChanges", async () => {
    const { work, write, plantHostileConfig, remoteFile } = await createClone();
    const marker = await plantHostileConfig();
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(pushChanges(work, "Add basil")).resolves.toBe(1);

    expect(await remoteFile("plan.md")).toBe("tomatoes\nbasil\n");
    expect(await ranScripts(marker)).toBe("");
  });

  it("runs none of them in pushNewBranch", async () => {
    const { work, write, plantHostileConfig, remoteFile } = await createClone();
    const marker = await plantHostileConfig();
    await write("plan.md", "tomatoes\nbasil\n");

    await pushNewBranch(work, {
      branch: "centaur/other",
      message: "Add basil",
      originalHeadSha: (await git(work, "rev-parse", "HEAD")).trim(),
    });

    expect(await remoteFile("plan.md", "centaur/other")).toBe("tomatoes\nbasil\n");
    expect(await ranScripts(marker)).toBe("");
  });

  it("runs none of them in the transplant behind pushExisting", async () => {
    const { work, base, write, plantHostileConfig, remoteFile } = await createClone();
    const marker = await plantHostileConfig();
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(
      pushExisting({
        workspace: work,
        headRef: "centaur/branch",
        number: 7,
        pullRequestUrl: "https://github.com/o/r/pull/7",
        message: "Add basil",
        tempDir: base,
      }),
    ).resolves.toMatchObject({ ok: true, commits: 1 });

    expect(await remoteFile("plan.md")).toBe("tomatoes\nbasil\n");
    expect(await ranScripts(marker)).toBe("");
  });

  it("does not run a planted ssh command when pushing over ssh", async () => {
    const { work, write, plantHostileConfig } = await createClone();
    const marker = await plantHostileConfig();
    await git(work, "remote", "set-url", "--push", "origin", "ssh://127.0.0.1:1/repo.git");
    await write("plan.md", "tomatoes\nbasil\n");

    await expect(pushChanges(work, "Add basil")).rejects.toThrow();

    expect(await ranScripts(marker)).toBe("");
  });
});
