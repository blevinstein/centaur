import { describe, expect, it, vi } from "vitest";
import {
  createGitHubClient,
  createGitHubRequester,
  fetchDefaultBranch,
  GitHubRequestError,
  REPLY_MARKER,
  resolve,
} from "../src/workflows/resolve.js";
import { issueComment, resolveSetup, review } from "./helpers/resolve-fixtures.js";

const RESOLVED = {
  skip: false,
  bot: "sprout",
  threadKey: "0123456789ab",
  headRef: "centaur/sprout-abc123def456",
  pullRequest: 12,
};

describe("resolve", () => {
  it.each([
    ["issue_comment", issueComment()],
    ["pull_request_review", review()],
  ])("resolves a %s from a writer on a linked centaur pull request", async (eventName, event) => {
    const { aws, mask, deps } = resolveSetup();

    await expect(resolve(deps(eventName, event))).resolves.toEqual({ ...RESOLVED, eventName });
    expect(mask).toHaveBeenCalledWith("jwt");
    expect(aws.requests).toEqual([
      { operation: "resolve-pull-request", token: "jwt", pullRequest: 12 },
    ]);
  });

  it.each([
    ["a bot sender", "issue_comment", issueComment({ sender: { type: "Bot", login: "ci[bot]" } })],
    [
      "a comment with the reply marker",
      "issue_comment",
      issueComment({ comment: { body: `done\n${REPLY_MARKER}` } }),
    ],
    [
      "a review with the reply marker",
      "pull_request_review",
      review({ review: { body: REPLY_MARKER } }),
    ],
    ["a plain issue comment", "issue_comment", issueComment({ issue: { number: 12 } })],
    ["an edited comment", "issue_comment", issueComment({ action: "edited" })],
    ["a dismissed review", "pull_request_review", review({ action: "dismissed" })],
    ["an unsupported event", "push", {}],
  ])("skips %s before touching GitHub or the poster", async (_name, eventName, event) => {
    const { github, aws, deps } = resolveSetup();

    await expect(resolve(deps(eventName, event))).resolves.toMatchObject({ skip: true });
    expect(github.pullRequest).not.toHaveBeenCalled();
    expect(aws.requests).toEqual([]);
  });

  it.each([
    ["an issue comment", "issue_comment", issueComment, "comment"],
    ["a review", "pull_request_review", review, "review"],
  ])(
    "skips %s from an association the config does not allow",
    async (_n, eventName, build, key) => {
      const { github, aws, deps } = resolveSetup({ commentAuthors: ["OWNER"] });
      const event = build({ [key]: { body: "x", author_association: "COLLABORATOR" } });

      await expect(resolve(deps(eventName, event))).resolves.toMatchObject({ skip: true });
      expect(github.permission).not.toHaveBeenCalled();
      expect(aws.requests).toEqual([]);
    },
  );

  it("skips an event with no author association", async () => {
    const { deps } = resolveSetup();

    await expect(
      resolve(deps("issue_comment", issueComment({ comment: { body: "x" } }))),
    ).resolves.toMatchObject({ skip: true });
  });

  it("resolves a commenter whose association the config allows", async () => {
    const { deps } = resolveSetup({ commentAuthors: ["CONTRIBUTOR"] });
    const event = issueComment({ comment: { body: "x", author_association: "CONTRIBUTOR" } });

    await expect(resolve(deps("issue_comment", event))).resolves.toMatchObject({ skip: false });
  });

  it.each([
    ["closed", { state: "closed" }],
    ["from a fork", { headRepository: "fork/sprout" }],
    ["from a deleted fork", { headRepository: undefined }],
    ["on another branch", { headRef: "feature/x" }],
  ])("skips a pull request that is %s", async (_name, pullRequest) => {
    const { github, aws, deps } = resolveSetup({ pullRequest });

    await expect(resolve(deps("issue_comment", issueComment()))).resolves.toMatchObject({
      skip: true,
    });
    expect(github.permission).not.toHaveBeenCalled();
    expect(aws.requests).toEqual([]);
  });

  it.each([
    ["read", "read", 0],
    ["triage", "triage", 0],
    ["a 403", new GitHubRequestError(403), 0],
    ["a 404", new GitHubRequestError(404), 0],
    ["a 500", new GitHubRequestError(500), 1],
    ["a network error", new TypeError("fetch failed"), 1],
  ])("fails closed when the commenter permission is %s", async (_name, permission, warnings) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { aws, deps } = resolveSetup({ permission });

    await expect(resolve(deps("issue_comment", issueComment()))).resolves.toMatchObject({
      skip: true,
    });
    expect(aws.requests).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(warnings);
    warn.mockRestore();
  });

  it("names only the status in the permission warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = resolveSetup({ permission: new GitHubRequestError(502) });

    await resolve(deps("issue_comment", issueComment({ body: "secret text" })));

    expect(warn).toHaveBeenCalledWith("::warning::could not check commenter permission (502)");
    warn.mockRestore();
  });

  it.each(["maintain", "admin"])("accepts %s permission", async (permission) => {
    const { deps } = resolveSetup({ permission });

    await expect(resolve(deps("issue_comment", issueComment()))).resolves.toMatchObject({
      skip: false,
    });
  });

  it("skips a pull request with no linked thread", async () => {
    const { deps } = resolveSetup({ linked: false });

    await expect(resolve(deps("issue_comment", issueComment()))).resolves.toMatchObject({
      skip: true,
    });
  });

  it("never reports a raw thread ID", async () => {
    const { deps } = resolveSetup();

    expect(JSON.stringify(await resolve(deps("issue_comment", issueComment())))).not.toContain(
      "threadId",
    );
  });
});

describe("createGitHubClient", () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("maps the pull request and permission responses", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.endsWith("/permission")
            ? { permission: "write" }
            : {
                state: "open",
                head: { ref: "centaur/x", repo: { full_name: "o/r" } },
                base: { repo: { full_name: "o/r" } },
              },
        ),
      );
    }) as unknown as typeof fetch;
    const client = createGitHubClient("t", "https://api.test", fetchImpl);

    await expect(client.pullRequest("o/r", 3)).resolves.toEqual({
      state: "open",
      headRef: "centaur/x",
      headRepository: "o/r",
      baseRepository: "o/r",
    });
    await expect(client.permission("o/r", "a b")).resolves.toBe("write");
    expect(calls).toEqual([
      "https://api.test/repos/o/r/pulls/3",
      "https://api.test/repos/o/r/collaborators/a%20b/permission",
    ]);
  });

  it("reports only the status on failure", async () => {
    const client = createGitHubClient("t", "https://api.test", respond(403, { message: "secret" }));

    await expect(client.permission("o/r", "a")).rejects.toThrow(/^GitHub request failed \(403\)$/);
  });
});

describe("fetchDefaultBranch", () => {
  const requesterReturning = (status: number, body: unknown) =>
    createGitHubRequester(
      "token",
      "https://api.example.test",
      vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
    );

  it("reads the branch name from the repository API", async () => {
    await expect(
      fetchDefaultBranch(requesterReturning(200, { default_branch: "trunk" }), "o/r"),
    ).resolves.toBe("trunk");
  });

  it("fails on an API error or an empty name", async () => {
    await expect(fetchDefaultBranch(requesterReturning(500, {}), "o/r")).rejects.toBeInstanceOf(
      GitHubRequestError,
    );
    await expect(
      fetchDefaultBranch(requesterReturning(200, { default_branch: "" }), "o/r"),
    ).rejects.toThrow();
  });
});
