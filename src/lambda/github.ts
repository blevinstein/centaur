import type { SelfIdentity } from "../self-identity.js";
import { requestTimeout } from "./request-timeout.js";

export type ClientPayload = Record<string, string | SelfIdentity>;

export interface RepositoryDispatcher {
  dispatch(repo: string, eventType: string, clientPayload: ClientPayload): Promise<void>;
}

export class DispatchError extends Error {
  constructor(
    repo: string,
    readonly status: number,
  ) {
    super(`repository_dispatch to ${repo} failed with HTTP ${status}`);
    this.name = "DispatchError";
  }
}

export function createGitHubDispatcher(token: string, fetchImpl = fetch): RepositoryDispatcher {
  return {
    async dispatch(repo, eventType, clientPayload) {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "centaur-receiver",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
        signal: requestTimeout(),
      });
      if (!response.ok) throw new DispatchError(repo, response.status);
    },
  };
}
