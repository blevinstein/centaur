import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, execCommand } from "./aws.js";
import { BRANCH_PREFIX } from "./resolve.js";

const BOT_IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];
const NEVER_COMMITTED = [".centaur-turn", ".centaur-trusted"];
const SAFE_HEAD_REF = /^[A-Za-z0-9._/-]+$/;

export type PushExistingFailure =
  | "invalid_ref"
  | "patch_failed"
  | "fetch_failed"
  | "conflict"
  | "push_rejected";

export type PushExistingResult =
  | { ok: true; commits: 0 }
  | { ok: true; commits: 1; url: string; number: number }
  | { ok: false; reason: PushExistingFailure };

export interface PushExistingOptions {
  workspace: string;
  headRef: string;
  number: number;
  pullRequestUrl: string;
  message: string;
  tempDir?: string | undefined;
  exec?: Exec | undefined;
}

export const isValidHeadRef = (ref: string) =>
  ref.startsWith(BRANCH_PREFIX) &&
  SAFE_HEAD_REF.test(ref) &&
  !ref.includes("..") &&
  !ref.includes("//") &&
  !ref.endsWith("/") &&
  !ref.endsWith(".lock");

/**
 * Applies the workspace's changes onto the tip of an existing pull request branch from a separate
 * worktree and pushes with a plain `git push`, so the workspace keeps the agent's files for a
 * fallback. Every failure is reported as a reason code that carries no repository content.
 */
export async function pushExisting(options: PushExistingOptions): Promise<PushExistingResult> {
  const { workspace, headRef, message, exec = execCommand } = options;
  if (!isValidHeadRef(headRef)) return { ok: false, reason: "invalid_ref" };
  const git = (...args: string[]) => exec("git", ["-C", workspace, ...args]);
  const scratch = await mkdtemp(join(options.tempDir ?? tmpdir(), "centaur-push-"));
  const patch = join(scratch, "changes.patch");
  const worktree = join(scratch, "pr");
  let added = false;
  const attempt = async (reason: PushExistingFailure, run: () => Promise<unknown>) => {
    try {
      await run();
      return undefined;
    } catch {
      return { ok: false, reason } as const;
    }
  };
  try {
    const prepared = await attempt("patch_failed", async () => {
      await git("add", "--all");
      await git("reset", "--quiet", "--", ...NEVER_COMMITTED);
      await git("diff", "--cached", "--binary", `--output=${patch}`, "HEAD");
    });
    if (prepared) return prepared;
    if ((await stat(patch)).size === 0) return { ok: true, commits: 0 };

    const remoteRef = `refs/remotes/origin/${headRef}`;
    const inWorktree = (...args: string[]) => exec("git", ["-C", worktree, ...args]);
    const steps: [PushExistingFailure, () => Promise<unknown>][] = [
      ["fetch_failed", () => git("fetch", "origin", `+refs/heads/${headRef}:${remoteRef}`)],
      [
        "fetch_failed",
        async () => {
          await git("worktree", "add", "--detach", worktree, remoteRef);
          added = true;
        },
      ],
      ["conflict", () => inWorktree("apply", "--3way", "--index", patch)],
      ["conflict", () => inWorktree(...BOT_IDENTITY, "commit", "--message", message)],
      ["push_rejected", () => inWorktree("push", "origin", `HEAD:refs/heads/${headRef}`)],
    ];
    for (const [reason, run] of steps) {
      const failure = await attempt(reason, run);
      if (failure) return failure;
    }
    return { ok: true, commits: 1, url: options.pullRequestUrl, number: options.number };
  } finally {
    if (added) await git("worktree", "remove", "--force", worktree).catch(() => undefined);
    await git("worktree", "prune").catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
