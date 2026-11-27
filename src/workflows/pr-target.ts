import { z } from "zod";
import type { CentaurConfig } from "../config/index.js";
import type { PosterClient } from "./aws.js";
import { extractResult } from "./finish.js";
import { paginate } from "./pull-request-comments.js";
import { createGitHubRequester, isThreadBranch, type PullRequestInfo } from "./resolve.js";

/** The author of pull requests opened with the workflow's `GITHUB_TOKEN`. */
export const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
export const MAX_CANDIDATES = 10;

export interface CandidatePullRequest extends PullRequestInfo {
  number: number;
  title: string;
  updatedAt: string;
  author: string | undefined;
}

export interface PullRequestTargetClient {
  listOpenPullRequests(repository: string): Promise<CandidatePullRequest[]>;
  pullRequest(repository: string, number: number): Promise<CandidatePullRequest>;
}

/** The thread's own open pull request, whose branch `prepare` checked out as the workspace. */
export interface ThreadPullRequest {
  number: number;
  headRef: string;
}

export type Rejection = "not_open" | "not_candidate" | "not_allowed" | "lookup_failed";

export interface TargetDeps {
  repository: string;
  github: PullRequestTargetClient;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

export interface CandidateDeps extends TargetDeps {
  bot: string;
  poster: PosterClient;
}

export interface ExistingTarget {
  target: "existing";
  number: number;
  headRef: string;
  fallbackReason?: Rejection;
}

export interface ThreadTarget {
  target: "thread";
  fallbackReason?: Rejection;
}

export type PrTarget = ThreadTarget | ExistingTarget | { target: "direct" };

const candidateResponse = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  updated_at: z.string(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

const toCandidate = (data: z.infer<typeof candidateResponse>): CandidatePullRequest => ({
  number: data.number,
  title: data.title,
  updatedAt: data.updated_at,
  state: data.state,
  author: data.user?.login,
  headRef: data.head.ref,
  headRepository: data.head.repo?.full_name,
  baseRepository: data.base.repo.full_name,
});

export function createPullRequestTargetClient(
  token: string,
  apiUrl?: string,
  fetchImpl?: typeof fetch,
): PullRequestTargetClient {
  const requester = createGitHubRequester(token, apiUrl, fetchImpl);
  return {
    async listOpenPullRequests(repository) {
      const all = await paginate(requester, `/repos/${repository}/pulls`, candidateResponse);
      return all.map(toCandidate);
    },
    async pullRequest(repository, number) {
      return toCandidate(
        await requester.json(`/repos/${repository}/pulls/${number}`, candidateResponse),
      );
    },
  };
}

const once = <T>(fn: () => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
};

/**
 * The single validity predicate for a pull request the agent may update: open, same repository
 * and not a fork, a `centaur/<bot>-<thread key>` branch opened by the workflow bot, and, when the poster has
 * a record for it, linked to this bot. A missing record is allowed (older pull requests predate
 * linking); a failed poster call fails closed. Returns the rejection reason, or undefined.
 */
export async function checkCandidate(
  deps: CandidateDeps,
  pullRequest: CandidatePullRequest,
): Promise<Rejection | undefined> {
  if (pullRequest.state !== "open") return "not_open";
  if (
    pullRequest.headRepository !== pullRequest.baseRepository ||
    pullRequest.baseRepository !== deps.repository ||
    !isThreadBranch(deps.bot, pullRequest.headRef) ||
    pullRequest.author !== WORKFLOW_BOT_LOGIN
  ) {
    return "not_candidate";
  }
  try {
    const token = await deps.fetchToken();
    deps.mask(token);
    const linked = await deps.poster.call<{ found: false } | { found: true; bot: string }>({
      operation: "resolve-pull-request",
      token,
      pullRequest: pullRequest.number,
    });
    return linked.found && linked.bot !== deps.bot ? "not_allowed" : undefined;
  } catch {
    return "lookup_failed";
  }
}

/** Most recently updated first; the higher number wins a tie. */
const byRecency = (a: CandidatePullRequest, b: CandidatePullRequest) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number;

/**
 * The open pull request on `branch` that `checkCandidate` accepts, newest first, or undefined when
 * there is none. A failed poster lookup throws: the caller must not mistake it for "no pull request".
 */
export async function findPullRequestOnBranch(
  deps: CandidateDeps,
  branch: string,
): Promise<CandidatePullRequest | undefined> {
  const shared = { ...deps, fetchToken: once(deps.fetchToken) };
  const onBranch = (await deps.github.listOpenPullRequests(deps.repository)).filter(
    (pullRequest) => pullRequest.headRef === branch,
  );
  for (const pullRequest of onBranch.toSorted(byRecency)) {
    const rejection = await checkCandidate(shared, pullRequest);
    if (rejection === "lookup_failed") {
      throw new Error(`could not verify pull request #${pullRequest.number} on ${branch}`);
    }
    if (rejection === undefined) return pullRequest;
  }
  return undefined;
}

/** The newest `limit` open pull requests, by update time, that pass `checkCandidate`. */
export async function listCandidates(
  deps: CandidateDeps,
  limit = MAX_CANDIDATES,
): Promise<CandidatePullRequest[]> {
  const shared = { ...deps, fetchToken: once(deps.fetchToken) };
  const open = await deps.github.listOpenPullRequests(deps.repository);
  const candidates: CandidatePullRequest[] = [];
  for (const pullRequest of open.toSorted(byRecency)) {
    if (candidates.length >= limit) break;
    if ((await checkCandidate(shared, pullRequest)) === undefined) candidates.push(pullRequest);
  }
  return candidates;
}

/**
 * The turn's default target: the thread's own open pull request when `prepare` checked its branch
 * out (`threadPullRequest`), otherwise the thread's branch, which `create-pull-request` opens.
 */
const defaultTarget = (
  threadPullRequest: ThreadPullRequest | undefined,
): ThreadTarget | ExistingTarget =>
  threadPullRequest ? { target: "existing", ...threadPullRequest } : { target: "thread" };

/**
 * Resolves the agent's `existing_pr_number` against candidates recomputed from GitHub; anything
 * absent, malformed, or outside that set falls back to the thread's own pull request. The
 * fallback reason is a generic code that carries no pull request content.
 */
export async function planTarget(
  deps: CandidateDeps,
  existingPr: number | undefined,
  threadPullRequest?: ThreadPullRequest,
): Promise<PrTarget> {
  const fallback = defaultTarget(threadPullRequest);
  if (existingPr === undefined || !Number.isInteger(existingPr) || existingPr <= 0) {
    return fallback;
  }
  try {
    const hit = (await listCandidates(deps)).find((c) => c.number === existingPr);
    if (hit) return { target: "existing", number: hit.number, headRef: hit.headRef };
    const pullRequest = await deps.github.pullRequest(deps.repository, existingPr);
    const rejection = await checkCandidate(deps, pullRequest);
    return { ...fallback, fallbackReason: rejection ?? "not_allowed" };
  } catch {
    return { ...fallback, fallbackReason: "lookup_failed" };
  }
}

export const planOutputs = (plan: PrTarget): Record<string, string> => {
  switch (plan.target) {
    case "existing":
      return {
        target: "existing",
        number: String(plan.number),
        head_ref: plan.headRef,
        ...(plan.fallbackReason ? { fallback_reason: plan.fallbackReason } : {}),
      };
    case "direct":
      return { target: "direct" };
    case "thread":
      return { target: "thread", fallback_reason: plan.fallbackReason ?? "" };
  }
};

/** The agent's `existing_pr_number`, read from its structured output; absent when unreadable. */
export function requestedPullRequest(executionFileText: string): number | undefined {
  try {
    return extractResult(executionFileText).existingPr;
  } catch {
    return undefined;
  }
}

/**
 * Plans the turn's target from the trusted config. `direct` ignores the agent's output and
 * `existing`; otherwise, without GitHub access or with `existing: off`, it is the thread's.
 */
export async function planForTurn(
  deps: CandidateDeps | undefined,
  existing: "bot" | "off",
  executionFileText: string,
  mode: CentaurConfig["execution"]["mode"] = "pull_request",
  threadPullRequest?: ThreadPullRequest,
): Promise<PrTarget> {
  if (mode === "direct") return { target: "direct" };
  if (!deps || existing === "off") return defaultTarget(threadPullRequest);
  return planTarget(deps, requestedPullRequest(executionFileText), threadPullRequest);
}
