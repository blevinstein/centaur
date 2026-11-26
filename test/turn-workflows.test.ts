import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Job {
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  steps: { if?: string; uses?: string }[];
}

const jobs = (file: string) =>
  (parse(readFileSync(`.github/workflows/${file}`, "utf8")) as { jobs: Record<string, Job> }).jobs;

describe.each(["centaur-turn.yml", "centaur-comment-turn.yml"])("%s", (file) => {
  const { turn, "notify-timeout": timeout } = jobs(file);

  it("notifies from a separate job when the turn job is cancelled by its timeout", () => {
    expect(turn?.["timeout-minutes"]).toBeGreaterThan(0);
    expect([timeout?.needs].flat()).toContain("turn");
    expect(timeout?.if).toBe("always() && needs.turn.result == 'cancelled'");
    expect(timeout?.steps.at(-1)?.uses).toMatch(/actions\/notify-failure$/);
  });

  it("keeps the in-job notice for failed steps only, so a run sends one notice", () => {
    const notice = turn?.steps.find((step) => step.uses?.endsWith("actions/notify-failure"));
    expect(notice?.if).toBe("failure()");
  });
});
