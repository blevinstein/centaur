export interface RepositoryDispatcher {
  dispatch(repo: string, eventType: string, clientPayload: Record<string, string>): Promise<void>;
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
      });
      if (!response.ok) {
        throw new Error(`repository_dispatch to ${repo} failed with HTTP ${response.status}`);
      }
    },
  };
}
