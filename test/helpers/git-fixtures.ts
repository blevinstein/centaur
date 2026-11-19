import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execCommand } from "../../src/workflows/aws.js";

export const git = (cwd: string, ...args: string[]) =>
  execCommand("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

/** A clone of a bare remote whose `centaur/branch` is checked out with its upstream set. */
export async function createClone() {
  const base = await mkdtemp(join(tmpdir(), "centaur-git-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  await execCommand("git", ["init", "--bare", "--initial-branch=main", remote]);
  await execCommand("git", ["clone", remote, work]);
  await writeFile(join(work, "plan.md"), "tomatoes\n");
  await git(work, "add", "plan.md");
  await git(work, "commit", "-m", "init");
  await git(work, "push", "origin", "HEAD:main");
  await git(work, "switch", "-c", "centaur/branch");
  await git(work, "push", "--set-upstream", "origin", "centaur/branch");
  const write = async (file: string, content: string) => {
    await mkdir(dirname(join(work, file)), { recursive: true });
    await writeFile(join(work, file), content);
  };
  const remoteLog = () => git(remote, "log", "--format=%s|%an", "centaur/branch");
  return { work, write, remoteLog };
}
