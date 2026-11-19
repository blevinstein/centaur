import { vi } from "vitest";
import type { GitHubClient, PullRequestInfo } from "../../src/workflows/resolve.js";
import { createFakeAws } from "./workflow-fixtures.js";

export const REPOSITORY = "octo/sprout";

export const issueComment = (overrides: Record<string, unknown> = {}) => ({
  action: "created",
  sender: { type: "User", login: "sam" },
  issue: { number: 12, pull_request: { url: "x" } },
  comment: { body: "please rename this" },
  ...overrides,
});

export const review = (overrides: Record<string, unknown> = {}) => ({
  action: "submitted",
  sender: { type: "User", login: "sam" },
  pull_request: { number: 12 },
  review: { body: "needs work" },
  ...overrides,
});

const openPullRequest: PullRequestInfo = {
  state: "open",
  headRef: "centaur/sprout-abc123def456",
  headRepository: REPOSITORY,
  baseRepository: REPOSITORY,
};

export function resolveSetup(
  options: {
    pullRequest?: Partial<PullRequestInfo>;
    permission?: string | Error;
    linked?: boolean;
  } = {},
) {
  const { permission = "write", linked = true } = options;
  const github: GitHubClient = {
    pullRequest: vi.fn(async () => ({ ...openPullRequest, ...options.pullRequest })),
    permission: vi.fn(async () => {
      if (permission instanceof Error) throw permission;
      return permission;
    }),
  };
  const aws = createFakeAws(() =>
    linked ? { found: true, bot: "sprout", threadKey: "0123456789ab" } : { found: false },
  );
  const mask = vi.fn();
  const deps = (eventName: string, event: unknown) => ({
    eventName,
    event,
    repository: REPOSITORY,
    github,
    poster: aws.poster,
    fetchToken: async () => "jwt",
    mask,
  });
  return { github, aws, mask, deps };
}
