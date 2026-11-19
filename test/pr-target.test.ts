import { describe, expect, it } from "vitest";
import {
  checkCandidate,
  listCandidates,
  MAX_CANDIDATES,
  planOutputs,
  planTarget,
} from "../src/workflows/pr-target.js";
import { candidatePr, targetSetup } from "./helpers/pr-target-fixtures.js";

describe("checkCandidate", () => {
  it("accepts an open, same-repo, bot-authored branch with no poster record", async () => {
    const { candidateDeps, mask, aws } = targetSetup();

    await expect(checkCandidate(candidateDeps, candidatePr(5))).resolves.toBeUndefined();
    expect(mask).toHaveBeenCalledWith("jwt");
    expect(aws.requests).toEqual([
      { operation: "resolve-pull-request", token: "jwt", pullRequest: 5 },
    ]);
  });

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
  it("returns the newest ten valid pull requests by number, skipping invalid ones", async () => {
    const open = Array.from({ length: 14 }, (_, i) => candidatePr(i + 1));
    open[12] = candidatePr(13, { headRepository: "fork/sprout" });
    const { candidateDeps } = targetSetup({ open: open.toReversed() });

    const numbers = (await listCandidates(candidateDeps)).map((c) => c.number);

    expect(MAX_CANDIDATES).toBe(10);
    expect(numbers).toEqual([14, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
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
  });
});
