import { describe, expect, it } from "vitest";
import {
  checkCandidate,
  listCandidates,
  MAX_CANDIDATES,
  planForTurn,
  planOutputs,
  planTarget,
  requestedPullRequest,
} from "../src/workflows/pr-target.js";
import { candidatePr, THREAD_KEY, targetSetup } from "./helpers/pr-target-fixtures.js";
import { executionText } from "./helpers/workflow-fixtures.js";

describe("checkCandidate", () => {
  it("accepts an open, same-repo, bot-authored branch with no poster record", async () => {
    const { candidateDeps, mask, aws } = targetSetup();

    await expect(checkCandidate(candidateDeps, candidatePr(5))).resolves.toBeUndefined();
    expect(mask).toHaveBeenCalledWith("jwt");
    expect(aws.requests).toEqual([
      { operation: "resolve-pull-request", token: "jwt", pullRequest: 5 },
    ]);
  });

  it.each([`centaur/sprout-${THREAD_KEY}`, `centaur/sprout-${THREAD_KEY}-123456-2`])(
    "accepts the thread branch %s",
    async (headRef) => {
      const { candidateDeps } = targetSetup();

      await expect(
        checkCandidate(candidateDeps, candidatePr(5, { headRef })),
      ).resolves.toBeUndefined();
    },
  );

  it("accepts a record naming the same bot", async () => {
    const { candidateDeps } = targetSetup({ links: { 5: { found: true, bot: "sprout" } } });

    await expect(checkCandidate(candidateDeps, candidatePr(5))).resolves.toBeUndefined();
  });

  it.each([
    ["closed", { state: "closed" }, "not_open"],
    ["from a fork", { headRepository: "fork/sprout" }, "not_candidate"],
    ["from a deleted fork", { headRepository: undefined }, "not_candidate"],
    [
      "against another repository",
      { baseRepository: "x/y", headRepository: "x/y" },
      "not_candidate",
    ],
    ["on a human branch", { headRef: "feature/x" }, "not_candidate"],
    ["on another bot's branch", { headRef: "centaur/other-abc" }, "not_candidate"],
    [
      "on a bot whose name extends this one's",
      { headRef: `centaur/sprout-2-${THREAD_KEY}` },
      "not_candidate",
    ],
    ["on a branch with a malformed thread key", { headRef: "centaur/sprout-abc" }, "not_candidate"],
    [
      "on a branch with trailing text after the key",
      { headRef: `centaur/sprout-${THREAD_KEY}-x` },
      "not_candidate",
    ],
    ["authored by a human", { author: "sam" }, "not_candidate"],
    ["authored by nobody", { author: undefined }, "not_candidate"],
  ] as const)(
    "rejects a pull request that is %s before calling the poster",
    async (_name, overrides, reason) => {
      const { candidateDeps, aws } = targetSetup();

      await expect(checkCandidate(candidateDeps, candidatePr(5, overrides))).resolves.toBe(reason);
      expect(aws.requests).toEqual([]);
    },
  );

  it("rejects a record naming another bot", async () => {
    const { candidateDeps } = targetSetup({ links: { 5: { found: true, bot: "other" } } });

    await expect(checkCandidate(candidateDeps, candidatePr(5))).resolves.toBe("not_allowed");
  });

  it("fails closed when the poster errors or the token cannot be fetched", async () => {
    const failing = targetSetup({ links: { 5: new Error("poster down") } });
    await expect(checkCandidate(failing.candidateDeps, candidatePr(5))).resolves.toBe(
      "lookup_failed",
    );

    const noToken = targetSetup();
    const deps = {
      ...noToken.candidateDeps,
      fetchToken: async () => {
        throw new Error("no oidc");
      },
    };
    await expect(checkCandidate(deps, candidatePr(5))).resolves.toBe("lookup_failed");
  });
});

describe("listCandidates", () => {
  it("returns the ten most recently updated valid pull requests, skipping invalid ones", async () => {
    const open = Array.from({ length: 14 }, (_, i) => candidatePr(i + 1));
    open[12] = candidatePr(13, { headRepository: "fork/sprout" });
    const { candidateDeps } = targetSetup({ open: open.toReversed() });

    const numbers = (await listCandidates(candidateDeps)).map((c) => c.number);

    expect(MAX_CANDIDATES).toBe(10);
    expect(numbers).toEqual([14, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it("ranks by most recent update rather than number, breaking ties by number", async () => {
    const stale = (number: number) => candidatePr(number, { updatedAt: "2026-10-01T00:00:00Z" });
    const fresh = (number: number, at: string) => candidatePr(number, { updatedAt: at });
    const { candidateDeps } = targetSetup({
      open: [
        stale(30),
        fresh(2, "2026-11-20T00:00:00Z"),
        fresh(1, "2026-11-20T00:00:00Z"),
        stale(31),
      ],
    });

    const numbers = (await listCandidates(candidateDeps, 3)).map((c) => c.number);

    expect(numbers).toEqual([2, 1, 31]);
  });

  it("fetches one token for the whole listing and excludes poster failures", async () => {
    let fetched = 0;
    const { candidateDeps } = targetSetup({
      open: [candidatePr(1), candidatePr(2), candidatePr(3)],
      links: { 2: new Error("poster down"), 3: { found: true, bot: "other" } },
    });

    const result = await listCandidates({
      ...candidateDeps,
      fetchToken: async () => `jwt${++fetched}`,
    });

    expect(result.map((c) => c.number)).toEqual([1]);
    expect(fetched).toBe(1);
  });
});

describe("planTarget", () => {
  const open = [candidatePr(7, { title: "Weekly tasks" }), candidatePr(8)];

  it("targets a candidate recomputed from GitHub", async () => {
    const { candidateDeps } = targetSetup({ open });

    await expect(planTarget(candidateDeps, 7)).resolves.toEqual({
      target: "existing",
      number: 7,
      headRef: open[0]?.headRef,
      title: "Weekly tasks",
    });
  });

  it.each([undefined, 0, -3, 1.5, Number.NaN])("returns the default for %s", async (value) => {
    const { candidateDeps, github } = targetSetup({ open });

    await expect(planTarget(candidateDeps, value)).resolves.toEqual({ target: "thread" });
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
  });

  it.each([
    ["closed", { state: "closed" }, "not_open"],
    ["a fork", { headRepository: "fork/sprout" }, "not_candidate"],
    ["a human's", { author: "sam" }, "not_candidate"],
  ] as const)("falls back with %s", async (_name, overrides, reason) => {
    const { candidateDeps } = targetSetup({ open: [candidatePr(9, overrides)] });

    await expect(planTarget(candidateDeps, 9)).resolves.toEqual({
      target: "thread",
      fallbackReason: reason,
    });
  });

  it("falls back with not_allowed for another bot's record or a valid pull request beyond the cap", async () => {
    const other = targetSetup({ open, links: { 7: { found: true, bot: "other" } } });
    await expect(planTarget(other.candidateDeps, 7)).resolves.toEqual({
      target: "thread",
      fallbackReason: "not_allowed",
    });

    const many = targetSetup({ open: Array.from({ length: 11 }, (_, i) => candidatePr(i + 1)) });
    await expect(planTarget(many.candidateDeps, 1)).resolves.toEqual({
      target: "thread",
      fallbackReason: "not_allowed",
    });
  });

  it("falls back with lookup_failed when GitHub fails or the number is unknown", async () => {
    const down = targetSetup({ open, listFails: true });
    await expect(planTarget(down.candidateDeps, 7)).resolves.toEqual({
      target: "thread",
      fallbackReason: "lookup_failed",
    });

    const unknown = targetSetup({ open });
    await expect(planTarget(unknown.candidateDeps, 99)).resolves.toEqual({
      target: "thread",
      fallbackReason: "lookup_failed",
    });
  });

  it("names no pull request content in a fallback", async () => {
    const { candidateDeps } = targetSetup({
      open: [candidatePr(9, { title: "secret", state: "closed" })],
    });

    expect(JSON.stringify(await planTarget(candidateDeps, 9))).not.toContain("secret");
  });
});

describe("planOutputs", () => {
  it("maps plans to workflow outputs without the title", () => {
    expect(
      planOutputs({ target: "existing", number: 7, headRef: "centaur/sprout-a", title: "t" }),
    ).toEqual({ target: "existing", number: "7", head_ref: "centaur/sprout-a" });
    expect(planOutputs({ target: "thread", fallbackReason: "not_open" })).toEqual({
      target: "thread",
      fallback_reason: "not_open",
    });
    expect(planOutputs({ target: "thread" })).toEqual({ target: "thread", fallback_reason: "" });
    expect(planOutputs({ target: "direct" })).toEqual({ target: "direct" });
  });
});

describe("requestedPullRequest", () => {
  it("reads existing_pr_number from the agent's structured output", () => {
    expect(requestedPullRequest(executionText({ reply: "ok", existing_pr_number: 7 }))).toBe(7);
    expect(requestedPullRequest(executionText({ reply: "ok" }))).toBeUndefined();
  });

  it("is absent for unreadable output or a malformed number", () => {
    expect(requestedPullRequest("not json")).toBeUndefined();
    expect(
      requestedPullRequest(executionText({ reply: "ok", existing_pr_number: -1 })),
    ).toBeUndefined();
    expect(requestedPullRequest(executionText({ existing_pr_number: 3 }))).toBeUndefined();
  });
});

describe("planForTurn", () => {
  const execution = executionText({ reply: "ok", existing_pr_number: 5 });

  it("targets the agent's open candidate", async () => {
    const { candidateDeps } = targetSetup({ open: [candidatePr(5)] });

    await expect(planForTurn(candidateDeps, "bot", execution)).resolves.toMatchObject({
      target: "existing",
      number: 5,
    });
  });

  it("uses the thread's pull request when existing is off or there is no GitHub access", async () => {
    const { candidateDeps, github } = targetSetup({ open: [candidatePr(5)] });

    await expect(planForTurn(candidateDeps, "off", execution)).resolves.toEqual({
      target: "thread",
    });
    await expect(planForTurn(undefined, "bot", execution)).resolves.toEqual({ target: "thread" });
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
  });

  it("uses the thread's pull request, without a reason, when the agent named none", async () => {
    const { candidateDeps } = targetSetup({ open: [candidatePr(5)] });

    await expect(
      planForTurn(candidateDeps, "bot", executionText({ reply: "ok" })),
    ).resolves.toEqual({ target: "thread" });
  });

  it("plans a direct push from the trusted mode without reading the agent or GitHub", async () => {
    const { candidateDeps, github, aws } = targetSetup({ open: [candidatePr(5)] });

    await expect(planForTurn(candidateDeps, "bot", execution, "direct")).resolves.toEqual({
      target: "direct",
    });
    await expect(planForTurn(undefined, "off", "not json", "direct")).resolves.toEqual({
      target: "direct",
    });
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
    expect(aws.requests).toEqual([]);
  });

  it("plans exactly as before in pull_request mode", async () => {
    const { candidateDeps } = targetSetup({ open: [candidatePr(5)] });

    await expect(planForTurn(candidateDeps, "bot", execution, "pull_request")).resolves.toEqual(
      await planForTurn(candidateDeps, "bot", execution),
    );
    await expect(planForTurn(candidateDeps, "off", execution, "pull_request")).resolves.toEqual({
      target: "thread",
    });
  });
});
