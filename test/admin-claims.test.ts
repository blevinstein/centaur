import { describe, expect, it } from "vitest";
import { encodeClaim, hashClaimCode } from "../src/lambda/admin-claim-record.js";
import { CLAIMED_TEXT, INVALID_CODE_TEXT, MAX_CLAIM_FAILURES } from "../src/lambda/admin-claims.js";
import {
  ADMIN_PARAMETER,
  CLAIM_CODE,
  CLAIMER_ID,
  claimHarness,
  SLACK_CLAIM_PARAMETER,
} from "./helpers/access-fixtures.js";
import { SLACK_BOT } from "./helpers/receiver-fixtures.js";

describe("admin claim", () => {
  it("makes the sender the admin, consumes the claim and logs the ID only", async () => {
    const { attempt, params, parameter, invalidateAccess, logger } = await claimHarness();

    expect(await attempt(CLAIM_CODE)).toBe(CLAIMED_TEXT);

    expect(params.values[ADMIN_PARAMETER]).toBe(CLAIMER_ID);
    expect(params.values[parameter]).toBeUndefined();
    expect(invalidateAccess).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "admin claimed",
      expect.objectContaining({ userId: CLAIMER_ID }),
    );
    expect(await attempt(CLAIM_CODE)).toBeUndefined();
  });

  it("overwrites an existing admin", async () => {
    const { attempt, params } = await claimHarness();
    params.values[ADMIN_PARAMETER] = "5001";

    await attempt(CLAIM_CODE);

    expect(params.values[ADMIN_PARAMETER]).toBe(CLAIMER_ID);
  });

  it("works for the Slack bot named in a Slack claim", async () => {
    const { attempt, params } = await claimHarness({ bot: SLACK_BOT });

    expect(await attempt(CLAIM_CODE, { userId: "U7" })).toBe(CLAIMED_TEXT);

    expect(params.values["/centaur/admin/slack"]).toBe("U7");
    expect(params.values[SLACK_CLAIM_PARAMETER]).toBeUndefined();
  });

  it("rejects a wrong code without touching the admin or revealing anything", async () => {
    const { attempt, params, parameter, logger } = await claimHarness();

    expect(await attempt("guess-123")).toBe(INVALID_CODE_TEXT);

    expect(params.values[ADMIN_PARAMETER]).toBeUndefined();
    expect(params.values[parameter]).toBeDefined();
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).not.toContain(CLAIM_CODE);
    expect(logged).not.toContain("guess-123");
    expect(logged).not.toContain(hashClaimCode(CLAIM_CODE));
  });

  it("invalidates the claim after repeated failures, even from different senders", async () => {
    const { attempt, params, parameter } = await claimHarness();

    for (let failure = 1; failure <= MAX_CLAIM_FAILURES; failure++) {
      expect(await attempt("wrong", { userId: `${failure}` })).toBe(INVALID_CODE_TEXT);
    }

    expect(params.values[parameter]).toBeUndefined();
    expect(await attempt(CLAIM_CODE)).toBeUndefined();
    expect(params.values[ADMIN_PARAMETER]).toBeUndefined();
  });

  it("still accepts the right code after fewer failures than the limit", async () => {
    const { attempt } = await claimHarness();
    for (let failure = 1; failure < MAX_CLAIM_FAILURES; failure++) await attempt("wrong");

    expect(await attempt(CLAIM_CODE)).toBe(CLAIMED_TEXT);
  });

  it("counts failures per claim, so a replacement starts fresh", async () => {
    const { attempt, params, parameter } = await claimHarness();
    for (let failure = 1; failure < MAX_CLAIM_FAILURES; failure++) await attempt("wrong");
    params.values[parameter] = encodeClaim("garden", "another-code", new Date(Date.now() + 60_000));

    for (let failure = 1; failure < MAX_CLAIM_FAILURES; failure++) await attempt("wrong");

    expect(params.values[parameter]).toBeDefined();
    expect(await attempt("another-code")).toBe(CLAIMED_TEXT);
  });

  it.each([
    ["no claim is pending", { claim: false }, CLAIM_CODE, true],
    ["the claim is expired", { expiresInMs: -1 }, CLAIM_CODE, true],
    ["the claim names another bot", { claimedBot: "other" }, CLAIM_CODE, true],
    ["the message is not a direct message", {}, CLAIM_CODE, false],
    ["a wrong code arrives and no claim is pending", { claim: false }, "wrong", true],
  ])("ignores the message when %s", async (_name, options, code, isDM) => {
    const { attempt, params } = await claimHarness(options);

    expect(await attempt(code, { isDM })).toBeUndefined();

    expect(params.values[ADMIN_PARAMETER]).toBeUndefined();
  });

  it("deletes an expired claim", async () => {
    const { attempt, params, parameter } = await claimHarness({ expiresInMs: -1 });

    await attempt(CLAIM_CODE);

    expect(params.values[parameter]).toBeUndefined();
  });

  it("treats a malformed stored claim as absent", async () => {
    const { attempt, params, parameter } = await claimHarness();
    params.values[parameter] = "not json";

    expect(await attempt(CLAIM_CODE)).toBeUndefined();
  });
});
