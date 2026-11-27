import { describe, expect, it } from "vitest";
import { defaultTimeoutMinutes, loadWorkflow } from "./action-fixtures.js";

describe.each(["centaur-turn.yml", "centaur-comment-turn.yml"])("%s", (file) => {
  const workflow = loadWorkflow(file);
  const { turn, "notify-timeout": timeout } = workflow.jobs;

  it("notifies from a separate job when the turn job is cancelled by its timeout", () => {
    expect(defaultTimeoutMinutes(workflow, turn)).toBeGreaterThan(0);
    expect([timeout?.needs].flat()).toContain("turn");
    expect(timeout?.if).toBe("always() && needs.turn.result == 'cancelled'");
    expect(timeout?.steps?.at(-1)?.uses).toMatch(/actions\/notify-failure$/);
  });

  it("keeps the in-job notice for failed steps only, so a run sends one notice", () => {
    const notice = turn?.steps?.find((step) => step.uses?.endsWith("actions/notify-failure"));
    expect(notice?.if).toBe("failure()");
  });
});
