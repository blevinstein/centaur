import type { Exec } from "./aws.js";
import { BRANCH_PREFIX } from "./resolve.js";
import { isSafeRef, transplantAndPush } from "./transplant.js";

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

export const isValidHeadRef = (ref: string) => ref.startsWith(BRANCH_PREFIX) && isSafeRef(ref);

/** Pushes the workspace's changes onto the tip of an existing `centaur/` pull request branch. */
export async function pushExisting(options: PushExistingOptions): Promise<PushExistingResult> {
  if (!isValidHeadRef(options.headRef)) return { ok: false, reason: "invalid_ref" };
  const result = await transplantAndPush({ ...options, ref: options.headRef });
  if (!result.ok) return { ok: false, reason: result.reason as PushExistingFailure };
  if (result.commits === 0) return result;
  return { ok: true, commits: 1, url: options.pullRequestUrl, number: options.number };
}
