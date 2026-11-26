import { describe, expect, it, vi } from "vitest";
import { CALLER_CHECKED_OPERATIONS } from "./helpers/caller-check-fixtures.js";
import { createFakeAws } from "./helpers/workflow-fixtures.js";

const NO_TOKEN_OPERATIONS = {
  "resolve-pull-request": { operation: "resolve-pull-request", token: "own", pullRequest: 3 },
} as const;

describe("the poster client's caller token", () => {
  it.each(Object.entries(CALLER_CHECKED_OPERATIONS))(
    "adds the token to %s",
    async (_name, request) => {
      const aws = createFakeAws(
        () => ({}),
        async () => "minted",
      );

      await aws.poster.call(request);

      expect(aws.requests).toEqual([{ ...request, token: "minted" }]);
    },
  );

  it("keeps a token the caller supplied", async () => {
    const fetchToken = vi.fn(async () => "minted");
    const aws = createFakeAws(() => ({}), fetchToken);

    await aws.poster.call(NO_TOKEN_OPERATIONS["resolve-pull-request"]);

    expect(aws.requests).toEqual([NO_TOKEN_OPERATIONS["resolve-pull-request"]]);
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it("sends the request without a token when none can be minted", async () => {
    const aws = createFakeAws(
      () => ({}),
      async () => {
        throw new Error("no grant");
      },
    );

    await aws.poster.call(CALLER_CHECKED_OPERATIONS.post);

    expect(aws.requests).toEqual([CALLER_CHECKED_OPERATIONS.post]);
  });

  it("sends the request unchanged without a token source", async () => {
    const aws = createFakeAws();

    await aws.poster.call(CALLER_CHECKED_OPERATIONS.post);

    expect(aws.requests).toEqual([CALLER_CHECKED_OPERATIONS.post]);
  });
});

describe("the fake poster", () => {
  it("rejects a request the poster's schema would reject", async () => {
    const aws = createFakeAws();

    await expect(
      aws.poster.call({ ...CALLER_CHECKED_OPERATIONS.post, extra: true } as never),
    ).rejects.toThrow(/poster post failed|aws lambda invoke failed/);
    expect(aws.requests).toEqual([]);
  });
});
