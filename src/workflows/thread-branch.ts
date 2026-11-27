import { join } from "node:path";
import { type Exec, execCommand } from "./aws.js";
import {
  type CandidateDeps,
  findPullRequestOnBranch,
  type ThreadPullRequest,
} from "./pr-target.js";
import { gitIn } from "./push.js";
import { isValidHeadRef } from "./push-existing.js";

export interface ThreadBranchStart {
  workspace: string;
  stateDir: string;
  branch: string;
  /** Where the config is read from when it is not the workspace; undefined makes a trusted copy. */
  configRoot: string | undefined;
  exec?: Exec | undefined;
}

export interface ThreadBranchCheckout extends ThreadPullRequest {
  /** The directory later steps and the persona must read the config from, outside the agent's reach. */
  configRoot: string;
}

const TRUSTED_DIR = "trusted";

/**
 * Makes the workspace a checkout of `branch`, tracking its remote, so the agent starts from the tip
 * and a later `git push` extends it. The workspace's previous commit stays available as a detached
 * worktree under `stateDir`, which is where the config must keep coming from: the branch holds
 * content earlier turns wrote, which must not decide the agent's tools, persona or execution mode.
 * `branch` must come from the thread key, never the agent.
 */
export async function checkoutBranch(options: ThreadBranchStart): Promise<string> {
  const { workspace, stateDir, branch, exec = execCommand } = options;
  if (!isValidHeadRef(branch)) throw new Error(`refusing to check out invalid branch ${branch}`);
  const git = gitIn(workspace, exec);
  const trustedRoot = options.configRoot ?? join(stateDir, TRUSTED_DIR);
  if (!options.configRoot) await git("worktree", "add", "--detach", trustedRoot, "HEAD");
  const remoteRef = `refs/remotes/origin/${branch}`;
  await git("fetch", "origin", `+refs/heads/${branch}:${remoteRef}`);
  await git("switch", "--force-create", branch, "--track", remoteRef);
  return trustedRoot;
}

/**
 * Starts the turn from the tip of the thread's own branch when it has an open pull request opened
 * by the workflow bot: the open pull request holds earlier turns' commits that the turn must see
 * and extend. Returns undefined, leaving the workspace on the default branch, when the branch has
 * no such pull request (none yet, merged or closed). A failed lookup, fetch or checkout throws
 * rather than start from a base that would drop those commits.
 */
export async function startFromThreadBranch(
  deps: CandidateDeps,
  options: ThreadBranchStart,
): Promise<ThreadBranchCheckout | undefined> {
  const pullRequest = await findPullRequestOnBranch(deps, options.branch);
  if (!pullRequest) return undefined;
  const configRoot = await checkoutBranch(options);
  return { number: pullRequest.number, headRef: options.branch, configRoot };
}
