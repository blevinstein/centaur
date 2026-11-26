import { appendFile, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Exec, execCommand } from "../../src/workflows/aws.js";

export const git = (cwd: string, ...args: string[]) =>
  execCommand("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

/** A clone of a bare remote whose `centaur/branch` is checked out with its upstream set. */
export async function createClone(options: { ignoreTurnDir?: boolean } = {}) {
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
  if (options.ignoreTurnDir ?? true) {
    await appendFile(join(work, ".git", "info", "exclude"), ".centaur-turn/\n");
  }
  const write = async (file: string, content: string) => {
    await mkdir(dirname(join(work, file)), { recursive: true });
    await writeFile(join(work, file), content);
  };
  const remoteLog = (branch = "centaur/branch") => git(remote, "log", "--format=%s|%an", branch);
  const advanceRemote = async (file: string, content: string, branch = "centaur/branch") => {
    const other = join(base, `other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await execCommand("git", ["clone", "--branch", branch, remote, other]);
    await writeFile(join(other, file), content);
    await git(other, "add", file);
    await git(other, "commit", "-m", "remote change");
    await git(other, "push", "origin", branch);
  };
  const remoteFile = (file: string, branch = "centaur/branch") =>
    git(remote, "show", `${branch}:${file}`);
  const remoteFiles = async (branch = "centaur/branch") =>
    (await git(remote, "ls-tree", "-r", "--name-only", branch)).trim().split("\n");
  /** Wraps `exec` so the remote branch advances right after each of the first `times` fetches. */
  const raceFetches = (branch: string, times: number): Exec => {
    let raced = 0;
    return async (file, args) => {
      const out = await execCommand(file, args);
      if (args.includes("fetch") && raced < times) {
        await advanceRemote(`race-${raced++}.md`, "won\n", branch);
      }
      return out;
    };
  };
  const rejectPushes = async () => {
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    await chmod(hook, 0o755);
  };
  return {
    work,
    base,
    remote,
    write,
    remoteLog,
    advanceRemote,
    remoteFile,
    remoteFiles,
    raceFetches,
    rejectPushes,
  };
}
