import { describe, expect, it, vi } from "vitest";
import { createBranchClient, deleteMergedBranch } from "../src/workflows/delete-merged-branch.js";
import { createGitHubRequester } from "../src/workflows/resolve.js";
import {
  BRANCH,
  branchSetup,
  closedEvent,
  MERGED_SHA,
  REPOSITORY,
  refFetch,
} from "./helpers/delete-branch-fixtures.js";
import { createRunnerEnv, runWorkflowCommand } from "./helpers/workflow-cli-fixtures.js";
import { configText } from "./helpers/workflow-fixtures.js";

describe("deleteMergedBranch", () => {
  it("deletes the thread branch of a merged workflow pull request", async () => {
    const { github, run } = branchSetup();

    const outcome = await deleteMergedBranch(run(closedEvent()));

    expect(outcome).toEqual({ deleted: true, branch: BRANCH });
    expect(github.deleteBranch).toHaveBeenCalledWith(REPOSITORY, BRANCH);
  });

  it.each([
    ["not closed", closedEvent({ action: "opened" })],
    ["closed unmerged", closedEvent({ pull_request: { merged: false } })],
    [
      "from a fork",
      closedEvent({
        pull_request: {
          head: { ref: BRANCH, sha: MERGED_SHA, repo: { full_name: "evil/sprout" } },
        },
      }),
    ],
    [
      "from a deleted fork",
      closedEvent({ pull_request: { head: { ref: BRANCH, sha: MERGED_SHA, repo: null } } }),
    ],
    ["by a human", closedEvent({ pull_request: { user: { login: "sam" } } })],
    [
      "on a branch of another bot",
      closedEvent({
        pull_request: {
          head: {
            ref: "centaur/sprout-2-abc123def456",
            sha: MERGED_SHA,
            repo: { full_name: REPOSITORY },
          },
        },
      }),
    ],
    [
      "on a non-centaur branch",
      closedEvent({
        pull_request: { head: { ref: "main", sha: MERGED_SHA, repo: { full_name: REPOSITORY } } },
      }),
    ],
  ])("keeps the branch when the pull request is %s", async (_name, event) => {
    const { github, run } = branchSetup();

    const outcome = await deleteMergedBranch(run(event));

    expect(outcome.deleted).toBe(false);
    expect(github.deleteBranch).not.toHaveBeenCalled();
  });

  it("keeps a branch that has commits after the merged head", async () => {
    const { github, run } = branchSetup("b".repeat(40));

    expect(await deleteMergedBranch(run(closedEvent()))).toEqual({
      deleted: false,
      reason: "branch has commits after the merged head",
    });
    expect(github.deleteBranch).not.toHaveBeenCalled();
  });

  it("does nothing when the branch is already gone", async () => {
    const { github, run } = branchSetup(undefined);

    expect((await deleteMergedBranch(run(closedEvent()))).deleted).toBe(false);
    expect(github.deleteBranch).not.toHaveBeenCalled();
  });
});

describe("createBranchClient", () => {
  const clientWith = (fetchImpl: ReturnType<typeof refFetch>) =>
    createBranchClient(createGitHubRequester("t", "https://gh.example", fetchImpl as typeof fetch));

  it("reads the sha and deletes through the ref endpoint", async () => {
    const fetchImpl = refFetch();
    const client = clientWith(fetchImpl);

    expect(await client.branchSha(REPOSITORY, BRANCH)).toBe(MERGED_SHA);
    await client.deleteBranch(REPOSITORY, BRANCH);

    expect(fetchImpl.mock.calls.map(([url, init]) => [init?.method ?? "GET", String(url)])).toEqual(
      [
        ["GET", `https://gh.example/repos/${REPOSITORY}/git/refs/heads/${BRANCH}`],
        ["DELETE", `https://gh.example/repos/${REPOSITORY}/git/refs/heads/${BRANCH}`],
      ],
    );
  });

  it("reads a missing branch as undefined", async () => {
    expect(await clientWith(refFetch(404)).branchSha(REPOSITORY, BRANCH)).toBeUndefined();
  });

  it("fails on any other error", async () => {
    await expect(clientWith(refFetch(500)).branchSha(REPOSITORY, BRANCH)).rejects.toThrow("500");
    await expect(clientWith(refFetch(200, 403)).deleteBranch(REPOSITORY, BRANCH)).rejects.toThrow(
      "403",
    );
  });
});

describe("the delete-merged-branch command", () => {
  it("reads the bot from the config and deletes the merged branch", async () => {
    const fetchImpl = refFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { env } = await createRunnerEnv({
      files: { ".centaur.yml": configText() },
      event: closedEvent(),
      env: { GITHUB_TOKEN: "ghs" },
    });

    const result = await runWorkflowCommand("delete-merged-branch", env);

    expect(result.exitCode).toBeUndefined();
    expect(result.logs).toEqual([`Deleted merged branch ${BRANCH}`]);
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
});
