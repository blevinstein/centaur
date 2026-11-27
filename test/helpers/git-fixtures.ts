import { appendFile, chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  /** Plants hooks, fsmonitor, hooksPath, sshCommand and an included config in the work tree that each append their name to a marker file; returns the marker's path. */
  const plantHostileConfig = async () => {
    const marker = join(base, "ran.txt");
    const script = async (name: string) => {
      const path = join(base, `${name}.sh`);
      await writeFile(path, `#!/bin/sh\necho ${name} >> "${marker}"\n`);
      await chmod(path, 0o755);
      return path;
    };
    const hooksDir = join(base, "hooks");
    await mkdir(hooksDir);
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "pre-push", "post-checkout"]) {
      await copyFile(await script(hook), join(hooksDir, hook));
      await copyFile(await script(hook), join(work, ".git", "hooks", hook));
    }
    const included = join(base, "included.config");
    await writeFile(included, `[core]\n\tfsmonitor = ${await script("included-fsmonitor")}\n`);
    await git(work, "config", "core.hooksPath", hooksDir);
    await git(work, "config", "core.fsmonitor", await script("fsmonitor"));
    await git(work, "config", "core.sshCommand", await script("ssh"));
    await git(work, "config", "include.path", included);
    await git(work, "config", "credential.helper", await script("credential"));
    return marker;
  };
  return {
    work,
    base,
    plantHostileConfig,
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

/** Commits `content` at `file` in the clone's work tree. */
export async function commitFile(work: string, file: string, content: string) {
  await mkdir(dirname(join(work, file)), { recursive: true });
  await writeFile(join(work, file), content);
  await git(work, "add", file);
  await git(work, "commit", "-m", `add ${file}`);
}
