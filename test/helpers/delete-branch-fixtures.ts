import { vi } from "vitest";
import type { BranchClient } from "../../src/workflows/delete-merged-branch.js";

export const REPOSITORY = "octo/sprout";
export const BRANCH = "centaur/sprout-abc123def456";
export const MERGED_SHA = "a".repeat(40);

export const closedEvent = (
  overrides: { action?: string; pull_request?: Record<string, unknown> } = {},
) => ({
  action: "closed",
  ...overrides,
  pull_request: {
    merged: true,
    user: { login: "github-actions[bot]" },
    head: { ref: BRANCH, sha: MERGED_SHA, repo: { full_name: REPOSITORY } },
    base: { repo: { full_name: REPOSITORY } },
    ...overrides.pull_request,
  },
});

export const branchSetup = (...args: [sha?: string | undefined]) => {
  const sha = args.length ? args[0] : MERGED_SHA;
  const github: BranchClient = {
    branchSha: vi.fn(async () => sha),
    deleteBranch: vi.fn(async () => {}),
  };
  const run = (event: unknown, bot = "sprout") => ({ event, repository: REPOSITORY, bot, github });
  return { github, run };
};

/** A `fetch` for the git ref endpoints: GET answers `getStatus` (200 with a sha when 200), DELETE answers `deleteStatus`. */
export const refFetch = (getStatus = 200, deleteStatus = 204) =>
  vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: deleteStatus });
    return getStatus === 200
      ? Response.json({ object: { sha: MERGED_SHA } })
      : new Response("{}", { status: getStatus });
  });
