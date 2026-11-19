import { type Exec, execCommand } from "./aws.js";

const BOT_IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];
const TURN_DIR_PATH = ".centaur-turn";

/**
 * Commits the working tree changes (if any) onto the checked-out pull request branch and pushes it
 * with plain `git push`. Returns how many commits the branch gained over its upstream.
 */
export async function pushChanges(
  workspace: string,
  message: string,
  exec: Exec = execCommand,
): Promise<number> {
  const git = (...args: string[]) => exec("git", ["-C", workspace, ...args]);
  await git("add", "--all");
  await git("reset", "--quiet", "--", TURN_DIR_PATH);
  const staged = await git("diff", "--cached", "--name-only");
  if (staged.trim() !== "") await git(...BOT_IDENTITY, "commit", "--message", message);
  const ahead = Number((await git("rev-list", "--count", "@{upstream}..HEAD")).trim());
  if (ahead > 0) await git("push");
  return ahead;
}
