import type { StateAdapter } from "chat";
import { threadKey } from "../thread-key.js";
import type { OidcVerifier } from "./oidc.js";
import type { ParameterStore } from "./parameters.js";
import { isBoundTo, requireBound } from "./registry.js";

export const PULL_REQUEST_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface PullRequestRecord {
  bot: string;
  threadId: string;
}

export interface PullRequestDeps {
  params: ParameterStore;
  state: StateAdapter;
  oidc: OidcVerifier;
}

export const pullRequestKey = (repository: string, number: number) =>
  `pull-request:${repository}#${number}`;

export function createPullRequests({ params, state, oidc }: PullRequestDeps) {
  const link = async (request: {
    token: string;
    bot: string;
    threadId: string;
    pullRequest: number;
  }) => {
    const repository = await requireBound(params, oidc, request.token, request.bot);
    const { bot, threadId } = request;
    await state.set<PullRequestRecord>(
      pullRequestKey(repository, request.pullRequest),
      { bot, threadId },
      PULL_REQUEST_TTL_MS,
    );
    return { linked: true };
  };

  const resolve = async (request: {
    token: string;
    pullRequest: number;
    withThreadId?: boolean | undefined;
  }) => {
    const { repository } = await oidc.verify(request.token);
    const key = pullRequestKey(repository, request.pullRequest);
    const record = await state.get<PullRequestRecord>(key);
    if (!record || !(await isBoundTo(params, record.bot, repository))) return { found: false };
    await state.set(key, record, PULL_REQUEST_TTL_MS);
    return {
      found: true,
      bot: record.bot,
      threadKey: threadKey(record.bot, record.threadId),
      ...(request.withThreadId ? { threadId: record.threadId } : {}),
    };
  };

  return { link, resolve };
}
