import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, execCommand } from "./aws.js";
import { BOT_IDENTITY, gitIn, NEVER_COMMITTED } from "./push.js";

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export type TransplantFailure =
  | "invalid_ref"
  | "patch_failed"
  | "fetch_failed"
  | "conflict"
  | "push_rejected"
  | "protected_path";

export type TransplantResult =
  | { ok: true; commits: 0 }
  | { ok: true; commits: 1; sha: string }
  | { ok: false; reason: TransplantFailure };

export interface TransplantOptions {
  workspace: string;
  ref: string;
  message: string;
  isProtectedPath?: ((path: string) => boolean) | undefined;
  tempDir?: string | undefined;
  exec?: Exec | undefined;
}

export const isSafeRef = (ref: string) =>
  SAFE_REF.test(ref) &&
  !ref.startsWith("-") &&
  !ref.includes("..") &&
  !ref.includes("//") &&
  !ref.endsWith("/") &&
  !ref.endsWith(".lock");

/**
 * Applies the workspace's changes onto the tip of `ref` from a separate worktree and pushes with a
 * plain `git push`, so the workspace keeps the agent's files for a fallback. The caller validates
 * that `ref` is a branch it may write. Every failure is reported as a reason code that carries no
 * repository content.
 */
export async function transplantAndPush(options: TransplantOptions): Promise<TransplantResult> {
  const { workspace, ref, message, isProtectedPath, exec = execCommand } = options;
  if (!isSafeRef(ref)) return { ok: false, reason: "invalid_ref" };
  const git = gitIn(workspace, exec);
  const scratch = await mkdtemp(join(options.tempDir ?? tmpdir(), "centaur-push-"));
  const patch = join(scratch, "changes.patch");
  const worktree = join(scratch, "pr");
  let added = false;
  const attempt = async (reason: TransplantFailure, run: () => Promise<unknown>) => {
    try {
      await run();
      return undefined;
    } catch {
      return { ok: false, reason } as const;
    }
  };
  try {
    let touched: string[] = [];
    const prepared = await attempt("patch_failed", async () => {
      await git("add", "--all");
      await git("reset", "--quiet", "--", ...NEVER_COMMITTED);
      await git("diff", "--cached", "--no-ext-diff", "--binary", `--output=${patch}`, "HEAD");
      if (isProtectedPath) {
        touched = (await git("diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"))
          .split("\0")
          .filter(Boolean);
      }
    });
    if (prepared) return prepared;
    if ((await stat(patch)).size === 0) return { ok: true, commits: 0 };
    if (isProtectedPath && touched.some(isProtectedPath)) {
      return { ok: false, reason: "protected_path" };
    }

    const remoteRef = `refs/remotes/origin/${ref}`;
    const inWorktree = gitIn(worktree, exec);
    const steps: [TransplantFailure, () => Promise<unknown>][] = [
      ["fetch_failed", () => git("fetch", "origin", `+refs/heads/${ref}:${remoteRef}`)],
      [
        "fetch_failed",
        async () => {
          await git("worktree", "add", "--detach", worktree, remoteRef);
          added = true;
        },
      ],
      ["conflict", () => inWorktree("apply", "--3way", "--index", patch)],
      ["conflict", () => inWorktree(...BOT_IDENTITY, "commit", "--message", message)],
      ["push_rejected", () => inWorktree("push", "origin", `HEAD:refs/heads/${ref}`)],
    ];
    for (const [reason, run] of steps) {
      const failure = await attempt(reason, run);
      if (failure) return failure;
    }
    return { ok: true, commits: 1, sha: (await inWorktree("rev-parse", "HEAD")).trim() };
  } finally {
    if (added) await git("worktree", "remove", "--force", worktree).catch(() => undefined);
    await git("worktree", "prune").catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
