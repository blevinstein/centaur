import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  id?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
}

const steps: Step[] = parse(readFileSync(".github/actions/turn/action.yml", "utf8")).runs.steps;

const stepsWithEnv = (name: string) =>
  steps.filter((step) => step.env?.[name] !== undefined).map((step) => step.id);

describe("the turn action", () => {
  it("passes the config root to prepare, plan and finish from the config_root input", () => {
    const withRoot = steps.filter((step) => step.env?.CENTAUR_CONFIG_ROOT !== undefined);
    expect(withRoot.map((step) => step.id)).toEqual(["prepare", "plan", undefined]);
    for (const step of withRoot) {
      expect(step.env?.CENTAUR_CONFIG_ROOT).toMatch(/inputs\.config_root/);
    }
  });

  it("gives finish the pull request update outputs", () => {
    expect(stepsWithEnv("PULL_REQUEST_UPDATED")).toHaveLength(1);
    expect(stepsWithEnv("FALLBACK_REASON")).toHaveLength(1);
  });

  it("lets the pull request steps fail so finish still posts the reply", () => {
    for (const id of ["pr", "push_existing"]) {
      expect(steps.find((step) => step.id === id)?.["continue-on-error"]).toBe(true);
    }
    expect(stepsWithEnv("PULL_REQUEST_FAILED")).toHaveLength(1);
  });
});
