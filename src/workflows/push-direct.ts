import type { Exec } from "./aws.js";
import { type TransplantFailure, transplantAndPush } from "./transplant.js";

export type PushDirectResult =
  | { ok: true; commits: 0 }
  | { ok: true; commits: 1; sha: string }
  | { ok: false; reason: TransplantFailure };

export interface PushDirectOptions {
  workspace: string;
  defaultBranch: string;
  message: string;
  runUrl: string;
  tempDir?: string | undefined;
  exec?: Exec | undefined;
}

/** Paths that decide what runs or who reviews: all of `.github/`, CODEOWNERS, and `.centaur*` at any depth. */
export const isProtectedPath = (path: string) => {
  const segments = path.split("/");
  return (
    segments[0] === ".github" ||
    segments.some((segment) => segment.startsWith(".centaur")) ||
    ["CODEOWNERS", "docs/CODEOWNERS"].includes(path)
  );
};

/**
 * Lands the workspace's changes on the default branch, stacked on its current head. A branch that
 * moved during the push is retried once from a fresh fetch; every other failure is returned so the
 * caller can open a pull request instead. `defaultBranch` must come from the GitHub API.
 */
export async function pushDirect(options: PushDirectOptions): Promise<PushDirectResult> {
  const { defaultBranch, runUrl, message, ...rest } = options;
  const attempt = () =>
    transplantAndPush({
      ...rest,
      ref: defaultBranch,
      message: `${message}\n\nPushed in this workflow run: ${runUrl}`,
      isProtectedPath,
    });
  const first = await attempt();
  return !first.ok && first.reason === "push_rejected" ? attempt() : first;
}
