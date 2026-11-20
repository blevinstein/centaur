import { z } from "zod";
import type { PosterClient } from "./aws.js";

/** Hidden in every comment the agent posts, so `resolve` never answers its own output. */
export const REPLY_MARKER = "<!-- centaur:reply -->";
export const BRANCH_PREFIX = "centaur/";
const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

const sender = z.object({ type: z.string(), login: z.string().min(1) });
const pullRequestNumber = z.number().int().positive();

const issueCommentEvent = z.object({
  action: z.string(),
  sender,
  issue: z.object({ number: pullRequestNumber, pull_request: z.unknown().optional() }),
  comment: z.object({ body: z.string().nullish() }),
});

const reviewEvent = z.object({
  action: z.string(),
  sender,
  pull_request: z.object({ number: pullRequestNumber }),
  review: z.object({ body: z.string().nullish() }),
});

export interface PullRequestInfo {
  state: string;
  headRef: string;
  headRepository: string | undefined;
  baseRepository: string;
}

export interface GitHubClient {
  pullRequest(repository: string, number: number): Promise<PullRequestInfo>;
  permission(repository: string, login: string): Promise<string>;
}

export interface ResolveDeps {
  eventName: string;
  event: unknown;
  repository: string;
  github: GitHubClient;
  poster: PosterClient;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

export type ResolveOutputs =
  | { skip: true; reason: string }
  | {
      skip: false;
      bot: string;
      threadKey: string;
      headRef: string;
      pullRequest: number;
      eventName: string;
    };

const skip = (reason: string): ResolveOutputs => ({ skip: true, reason });

/** Returns the pull request number and comment body when the event is a new human-visible comment. */
function parseEvent(eventName: string, event: unknown) {
  if (eventName === "issue_comment") {
    const parsed = issueCommentEvent.parse(event);
    if (parsed.action !== "created") return skip("not a new comment");
    if (!parsed.issue.pull_request) return skip("not a pull request");
    return { ...parsed, number: parsed.issue.number, body: parsed.comment.body ?? "" };
  }
  if (eventName === "pull_request_review") {
    const parsed = reviewEvent.parse(event);
    if (parsed.action !== "submitted") return skip("not a submitted review");
    return { ...parsed, number: parsed.pull_request.number, body: parsed.review.body ?? "" };
  }
  return skip(`unsupported event ${eventName}`);
}

/**
 * Decides whether a pull request comment event should start a turn and, if so, which bot and
 * thread it belongs to. Every cheap rejection comes before the permission check, and that comes
 * before the poster lookup. Reasons name no comment content.
 */
export async function resolve(deps: ResolveDeps): Promise<ResolveOutputs> {
  const event = parseEvent(deps.eventName, deps.event);
  if ("skip" in event) return event;
  if (event.sender.type === "Bot") return skip("sender is a bot");
  if (event.body.includes(REPLY_MARKER)) return skip("comment carries the reply marker");

  const pullRequest = await deps.github.pullRequest(deps.repository, event.number);
  if (pullRequest.state !== "open") return skip("pull request is not open");
  if (pullRequest.headRepository !== pullRequest.baseRepository)
    return skip("pull request is from a fork");
  if (!pullRequest.headRef.startsWith(BRANCH_PREFIX)) return skip("not a centaur branch");

  const permission = await deps.github
    .permission(deps.repository, event.sender.login)
    .catch(() => undefined);
  if (!permission || !WRITE_PERMISSIONS.has(permission)) {
    return skip("commenter lacks write access");
  }

  const token = await deps.fetchToken();
  deps.mask(token);
  const resolved = await deps.poster.call<
    { found: false } | { found: true; bot: string; threadKey: string }
  >({ operation: "resolve-pull-request", token, pullRequest: event.number });
  if (!resolved.found) return skip("pull request is not linked to a thread");

  return {
    skip: false,
    bot: resolved.bot,
    threadKey: resolved.threadKey,
    headRef: pullRequest.headRef,
    pullRequest: event.number,
    eventName: deps.eventName,
  };
}

const pullRequestResponse = z.object({
  state: z.string(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const permissionResponse = z.object({ permission: z.string() });

export interface GitHubRequester {
  json<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  text(path: string, accept: string): Promise<string>;
  post(path: string, body: unknown): Promise<void>;
  postJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number) {
    super(`GitHub request failed (${status})`);
  }
}

/** GitHub REST access; errors name only the status, never a response body. */
export function createGitHubRequester(
  token: string,
  apiUrl = "https://api.github.com",
  fetchImpl: typeof fetch = fetch,
): GitHubRequester {
  const get = async (path: string, accept: string) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new GitHubRequestError(response.status);
    return response;
  };
  const send = async (path: string, body: unknown) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new GitHubRequestError(response.status);
    return response;
  };
  return {
    async json(path, schema) {
      return schema.parse(await (await get(path, "application/vnd.github+json")).json());
    },
    async text(path, accept) {
      return (await get(path, accept)).text();
    },
    async post(path, body) {
      await send(path, body);
    },
    async postJson(path, body, schema) {
      return schema.parse(await (await send(path, body)).json());
    },
  };
}

export function createGitHubClient(
  token: string,
  apiUrl = "https://api.github.com",
  fetchImpl: typeof fetch = fetch,
): GitHubClient {
  const requester = createGitHubRequester(token, apiUrl, fetchImpl);
  const get = requester.json;
  return {
    async pullRequest(repository, number) {
      const data = await get(`/repos/${repository}/pulls/${number}`, pullRequestResponse);
      return {
        state: data.state,
        headRef: data.head.ref,
        headRepository: data.head.repo?.full_name,
        baseRepository: data.base.repo.full_name,
      };
    },
    async permission(repository, login) {
      const data = await get(
        `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        permissionResponse,
      );
      return data.permission;
    },
  };
}
