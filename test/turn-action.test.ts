import { describe, expect, it } from "vitest";
import { loadAction, stepsWithEnv } from "./action-fixtures.js";

const action = loadAction("turn");
const steps = action.runs.steps;
const idsWithEnv = (name: string) => stepsWithEnv(steps, name).map((step) => step.id);

describe("the turn action", () => {
  it("passes the config root to prepare, plan and finish from the config_root input", () => {
    const withRoot = steps.filter((step) => step.env?.CENTAUR_CONFIG_ROOT !== undefined);
    expect(withRoot.map((step) => step.id)).toEqual(["prepare", "plan", undefined]);
    for (const step of withRoot) {
      expect(step.env?.CENTAUR_CONFIG_ROOT).toMatch(/inputs\.config_root/);
    }
  });

  it("passes the root input to prepare, plan and finish as CENTAUR_ROOT", () => {
    expect(action.inputs?.root?.default).toBe(".");
    const withRoot = stepsWithEnv(steps, "CENTAUR_ROOT");
    expect(withRoot.map((step) => step.id)).toEqual(["prepare", "plan", undefined]);
    for (const step of withRoot) expect(step.env?.CENTAUR_ROOT).toMatch(/inputs\.root/);
  });

  it("points prepare at the skills folder next to the action's dist", () => {
    expect(idsWithEnv("CENTAUR_SKILLS_DIR")).toEqual(["prepare"]);
    expect(steps.find((step) => step.id === "prepare")?.env?.CENTAUR_SKILLS_DIR).toMatch(
      /^\$\{\{ github\.action_path \}\}\/\.\.\/\.\.\/\.\.\/skills$/,
    );
  });

  it("gives finish the pull request update outputs", () => {
    expect(idsWithEnv("PULL_REQUEST_UPDATED")).toHaveLength(1);
    expect(idsWithEnv("FALLBACK_REASON")).toHaveLength(1);
  });

  it("lets the pull request steps fail so finish still posts the reply", () => {
    for (const id of ["pr", "push_existing"]) {
      expect(steps.find((step) => step.id === id)?.["continue-on-error"]).toBe(true);
    }
    expect(idsWithEnv("PULL_REQUEST_FAILED")).toHaveLength(1);
  });
});
