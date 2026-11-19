import { type Exec, execCommand } from "./aws.js";

const BOT_IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];
const TURN_FILES_EXCLUDE = ":(exclude).centaur-turn";

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
  if ((await git("status", "--porcelain", "--", ".", TURN_FILES_EXCLUDE)).trim() !== "") {
    await git("add", "--all", "--", ".", TURN_FILES_EXCLUDE);
    await git(...BOT_IDENTITY, "commit", "--message", message);
  }
  const ahead = Number((await git("rev-list", "--count", "@{upstream}..HEAD")).trim());
  if (ahead > 0) await git("push");
  return ahead;
}
