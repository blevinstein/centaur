import { vi } from "vitest";
import {
  type CandidateDeps,
  type CandidatePullRequest,
  type PullRequestTargetClient,
  type TargetDeps,
  WORKFLOW_BOT_LOGIN,
} from "../../src/workflows/pr-target.js";
import { createFakeAws } from "./workflow-fixtures.js";

export const REPOSITORY = "octo/sprout";
export const THREAD_KEY = "0123456789ab";

export const candidatePr = (
  number: number,
  overrides: Partial<CandidatePullRequest> = {},
): CandidatePullRequest => ({
  number,
  title: `Change ${number}`,
  state: "open",
  author: WORKFLOW_BOT_LOGIN,
  headRef: `centaur/sprout-${String(number).padStart(12, "0")}`,
  headRepository: REPOSITORY,
  baseRepository: REPOSITORY,
  ...overrides,
});

type Link = { found: false } | { found: true; bot: string } | Error;

export function targetSetup(
  options: {
    open?: CandidatePullRequest[];
    links?: Record<number, Link>;
    listFails?: boolean;
  } = {},
) {
  const open = options.open ?? [];
  const github: PullRequestTargetClient = {
    listOpenPullRequests: vi.fn(async () => {
      if (options.listFails) throw new Error("GitHub request failed (500)");
      return open;
    }),
    pullRequest: vi.fn(async (_repository, number) => {
      const found = open.find((pr) => pr.number === number);
      if (!found) throw new Error("GitHub request failed (404)");
      return found;
    }),
  };
  const aws = createFakeAws((request) => {
    if (request.operation !== "resolve-pull-request") return {};
    const link = options.links?.[request.pullRequest] ?? { found: false };
    if (link instanceof Error) throw link;
    return link;
  });
  const mask = vi.fn();
  const targets: TargetDeps = {
    repository: REPOSITORY,
    github,
    fetchToken: async () => "jwt",
    mask,
  };
  const candidateDeps: CandidateDeps = { ...targets, bot: "sprout", poster: aws.poster };
  return { github, aws, mask, targets, candidateDeps };
}
