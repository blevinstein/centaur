import { type Exec, execCommand } from "./aws.js";

const BOT_IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];
const NEVER_COMMITTED = [".centaur-turn", ".centaur-trusted"];

const gitIn =
  (workspace: string, exec: Exec) =>
  (...args: string[]) =>
    exec("git", ["-C", workspace, ...args]);

type Git = ReturnType<typeof gitIn>;

/** Stages the working tree minus the turn and trusted directories; true when something is staged. */
async function stageChanges(git: Git) {
  await git("add", "--all");
  await git("reset", "--quiet", "--", ...NEVER_COMMITTED);
  return (await git("diff", "--cached", "--name-only")).trim() !== "";
}

const commitStaged = (git: Git, message: string) =>
  git(...BOT_IDENTITY, "commit", "--message", message);

const commitsAhead = async (git: Git) =>
  Number((await git("rev-list", "--count", "@{upstream}..HEAD")).trim());

/**
 * Commits the working tree changes (if any) onto the checked-out pull request branch and pushes it
 * with plain `git push`. Returns how many commits the branch gained over its upstream.
 */
export async function pushChanges(
  workspace: string,
  message: string,
  exec: Exec = execCommand,
): Promise<number> {
  const git = gitIn(workspace, exec);
  if (await stageChanges(git)) await commitStaged(git, message);
  const ahead = await commitsAhead(git);
  if (ahead > 0) await git("push");
  return ahead;
}

/**
 * Moves the working tree changes and any commits the agent made onto a new branch, commits and
 * pushes it with plain `git push`. The checked-out branch and its remote are left alone. Returns
 * undefined when there is nothing to push, otherwise whether `originalHeadSha` is an ancestor of
 * the new branch, i.e. whether a pull request from it can be stacked on the original branch.
 */
export async function pushNewBranch(
  workspace: string,
  options: { branch: string; message: string; originalHeadSha: string },
  exec: Exec = execCommand,
): Promise<{ stacked: boolean } | undefined> {
  const git = gitIn(workspace, exec);
  const staged = await stageChanges(git);
  if (!staged && (await commitsAhead(git)) === 0) return undefined;
  await git("switch", "--create", options.branch);
  if (staged) await commitStaged(git, options.message);
  const stacked = await git("merge-base", "--is-ancestor", options.originalHeadSha, "HEAD").then(
    () => true,
    () => false,
  );
  await git("push", "--set-upstream", "origin", options.branch);
  return { stacked };
}
