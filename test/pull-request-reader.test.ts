import { describe, expect, it } from "vitest";
import { createPullRequestReader } from "../src/workflows/pull-request-comments.js";
import { fakeGitHubFetch, restComment } from "./helpers/pr-comment-fixtures.js";

const readAssociation = async (association: string | undefined | null) => {
  const fetchImpl = fakeGitHubFetch({
    "/repos/octo/sprout/issues/12/comments": [restComment(1, association as string | undefined)],
  });
  const reader = createPullRequestReader("t", "https://gh.example", fetchImpl);
  return (await reader.comments("octo/sprout", 12))[0]?.association;
};

describe("pull request reader author association", () => {
  it.each(["OWNER", "CONTRIBUTOR", "NONE"])("reads the association %s", async (association) => {
    expect(await readAssociation(association)).toBe(association);
  });

  it.each([undefined, null])("reads a missing association (%s) as empty", async (association) => {
    expect(await readAssociation(association)).toBe("");
  });

  it("reads the association of reviews and inline comments", async () => {
    const fetchImpl = fakeGitHubFetch({
      "/repos/octo/sprout/pulls/12/reviews": [
        restComment(1, "MEMBER", { state: "APPROVED", submitted_at: "2026-11-17T10:00:01Z" }),
      ],
      "/repos/octo/sprout/pulls/12/comments": [
        restComment(2, "NONE", { path: "plan.md", diff_hunk: "@@" }),
      ],
    });
    const reader = createPullRequestReader("t", "https://gh.example", fetchImpl);

    const comments = await reader.comments("octo/sprout", 12);

    expect(comments.map((c) => [c.kind, c.association])).toEqual([
      ["review", "MEMBER"],
      ["inline", "NONE"],
    ]);
  });
});
