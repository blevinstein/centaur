import { z } from "zod";
import type { PosterClient } from "./aws.js";
import { extractResult } from "./finish.js";
import { paginate } from "./pull-request-comments.js";
import { BRANCH_PREFIX, createGitHubRequester, type PullRequestInfo } from "./resolve.js";

/** The author of pull requests opened with the workflow's `GITHUB_TOKEN`. */
export const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
export const MAX_CANDIDATES = 10;

export interface CandidatePullRequest extends PullRequestInfo {
  number: number;
  title: string;
  author: string | undefined;
}

export interface PullRequestTargetClient {
  listOpenPullRequests(repository: string): Promise<CandidatePullRequest[]>;
  pullRequest(repository: string, number: number): Promise<CandidatePullRequest>;
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

export type PrTarget =
  | { target: "thread"; fallbackReason?: Rejection }
  | { target: "existing"; number: number; headRef: string; title: string };

const candidateResponse = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

const toCandidate = (data: z.infer<typeof candidateResponse>): CandidatePullRequest => ({
  number: data.number,
  title: data.title,
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
 * and not a fork, a `centaur/<bot>-` branch opened by the workflow bot, and, when the poster has
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
    !pullRequest.headRef.startsWith(`${BRANCH_PREFIX}${deps.bot}-`) ||
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

/** The newest `limit` open pull requests, by number, that pass `checkCandidate`. */
export async function listCandidates(
  deps: CandidateDeps,
  limit = MAX_CANDIDATES,
): Promise<CandidatePullRequest[]> {
  const shared = { ...deps, fetchToken: once(deps.fetchToken) };
  const open = await deps.github.listOpenPullRequests(deps.repository);
  const candidates: CandidatePullRequest[] = [];
  for (const pullRequest of open.toSorted((a, b) => b.number - a.number)) {
    if (candidates.length >= limit) break;
    if ((await checkCandidate(shared, pullRequest)) === undefined) candidates.push(pullRequest);
  }
  return candidates;
}

/**
 * Resolves the agent's `existing_pr_number` against candidates recomputed from GitHub; anything
 * absent, malformed, or outside that set falls back to the thread's own pull request. The
 * fallback reason is a generic code that carries no pull request content.
 */
export async function planTarget(
  deps: CandidateDeps,
  existingPr: number | undefined,
): Promise<PrTarget> {
  if (existingPr === undefined || !Number.isInteger(existingPr) || existingPr <= 0) {
    return { target: "thread" };
  }
  try {
    const hit = (await listCandidates(deps)).find((c) => c.number === existingPr);
    if (hit) {
      return { target: "existing", number: hit.number, headRef: hit.headRef, title: hit.title };
    }
    const pullRequest = await deps.github.pullRequest(deps.repository, existingPr);
    const rejection = await checkCandidate(deps, pullRequest);
    return { target: "thread", fallbackReason: rejection ?? "not_allowed" };
  } catch {
    return { target: "thread", fallbackReason: "lookup_failed" };
  }
}

export const planOutputs = (plan: PrTarget): Record<string, string> =>
  plan.target === "existing"
    ? { target: "existing", number: String(plan.number), head_ref: plan.headRef }
    : { target: "thread", fallback_reason: plan.fallbackReason ?? "" };

/** The agent's `existing_pr_number`, read from its structured output; absent when unreadable. */
export function requestedPullRequest(executionFileText: string): number | undefined {
  try {
    return extractResult(executionFileText).existingPr;
  } catch {
    return undefined;
  }
}

/** Plans the turn's target; without GitHub access or with `existing: off` it is the thread's. */
export async function planForTurn(
  deps: CandidateDeps | undefined,
  existing: "bot" | "off",
  executionFileText: string,
): Promise<PrTarget> {
  if (!deps || existing === "off") return { target: "thread" };
  return planTarget(deps, requestedPullRequest(executionFileText));
}
