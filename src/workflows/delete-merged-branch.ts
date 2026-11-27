import { z } from "zod";
import { WORKFLOW_BOT_LOGIN } from "./pr-target.js";
import {
  createGitHubRequester,
  GitHubRequestError,
  type GitHubRequester,
  isThreadBranch,
} from "./resolve.js";

const closedPullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    merged: z.boolean().nullish(),
    user: z.object({ login: z.string() }).nullable(),
    head: z.object({
      ref: z.string(),
      sha: z.string().min(1),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
    base: z.object({ repo: z.object({ full_name: z.string() }) }),
  }),
});

const refResponse = z.object({ object: z.object({ sha: z.string() }) });

export interface BranchClient {
  /** The commit a branch points at, or undefined when it does not exist. */
  branchSha(repository: string, branch: string): Promise<string | undefined>;
  deleteBranch(repository: string, branch: string): Promise<void>;
}

export interface DeleteMergedBranchDeps {
  event: unknown;
  repository: string;
  bot: string;
  github: BranchClient;
}

export type DeleteOutcome = { deleted: true; branch: string } | { deleted: false; reason: string };

const kept = (reason: string): DeleteOutcome => ({ deleted: false, reason });

const refPath = (repository: string, branch: string) =>
  `/repos/${repository}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;

export function createBranchClient(requester: GitHubRequester): BranchClient {
  return {
    async branchSha(repository, branch) {
      try {
        return (await requester.json(refPath(repository, branch), refResponse)).object.sha;
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return undefined;
        throw error;
      }
    },
    async deleteBranch(repository, branch) {
      await requester.delete(refPath(repository, branch));
    },
  };
}

export const createBranchClientFor = (token: string, apiUrl?: string) =>
  createBranchClient(createGitHubRequester(token, apiUrl));

/**
 * Deletes a thread branch once its pull request is merged. Only a branch this bot's workflow
 * created is touched: a same-repository pull request from the workflow bot on
 * `centaur/<bot>-<thread key>`. The branch goes only while it still points at the merged head, so
 * a commit pushed after the merge is never discarded. The next message in the thread starts from
 * the default branch, since `prepare` follows open pull requests only.
 */
export async function deleteMergedBranch(deps: DeleteMergedBranchDeps): Promise<DeleteOutcome> {
  const event = closedPullRequestEvent.parse(deps.event);
  if (event.action !== "closed") return kept("not a closed pull request");
  const { pull_request: pullRequest } = event;
  if (!pullRequest.merged) return kept("pull request was closed without merging");
  if (
    pullRequest.head.repo?.full_name !== deps.repository ||
    pullRequest.base.repo.full_name !== deps.repository
  ) {
    return kept("pull request is not from this repository");
  }
  if (pullRequest.user?.login !== WORKFLOW_BOT_LOGIN) return kept("not opened by the workflow bot");
  const branch = pullRequest.head.ref;
  if (!isThreadBranch(deps.bot, branch)) return kept("not a thread branch of this bot");

  const sha = await deps.github.branchSha(deps.repository, branch);
  if (sha === undefined) return kept("branch is already gone");
  if (sha !== pullRequest.head.sha) return kept("branch has commits after the merged head");
  await deps.github.deleteBranch(deps.repository, branch);
  return { deleted: true, branch };
}
