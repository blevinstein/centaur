import { describe, expect, it } from "vitest";
import { loadAction, stepsWithEnv } from "./action-fixtures.js";

const action = loadAction("turn");
const steps = action.runs.steps;
const idsWithEnv = (name: string) => stepsWithEnv(steps, name).map((step) => step.id);

describe("the turn action", () => {
  it("passes the config root to prepare, plan, push_direct and finish from the config_root input", () => {
    const withRoot = steps.filter((step) => step.env?.CENTAUR_CONFIG_ROOT !== undefined);
    expect(withRoot.map((step) => step.id)).toEqual(["prepare", "plan", "push_direct", undefined]);
    for (const step of withRoot) {
      expect(step.env?.CENTAUR_CONFIG_ROOT).toMatch(/inputs\.config_root/);
    }
  });

  it("passes the root input to prepare, plan, push_direct and finish as CENTAUR_ROOT", () => {
    expect(action.inputs?.root?.default).toBe(".");
    const withRoot = stepsWithEnv(steps, "CENTAUR_ROOT");
    expect(withRoot.map((step) => step.id)).toEqual(["prepare", "plan", "push_direct", undefined]);
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

  describe("the tool call audit", () => {
    const audit = steps.find((step) => step.run?.endsWith(" audit-tool-calls"));
    const names = steps.map((step) => step.name);

    it("audits the agent's execution file before anything is pushed or posted", () => {
      expect(audit?.env?.EXECUTION_FILE).toMatch(/steps\.agent\.outputs\.execution_file/);
      expect(audit?.["continue-on-error"]).toBeUndefined();
      expect(names.indexOf(audit?.name)).toBeGreaterThan(names.indexOf("Run agent"));
      for (const later of ["Plan pull request target", "Open pull request", "Post reply"]) {
        expect(names.indexOf(audit?.name)).toBeLessThan(names.indexOf(later));
      }
    });

    it("runs whenever the agent did", () => {
      expect(audit?.if).toBe("steps.prepare.outputs.skip != 'true'");
    });
  });

  describe("the direct push", () => {
    const step = (id: string) => steps.find((candidate) => candidate.id === id);
    const ids = steps.map((candidate) => candidate.id);

    it("runs only for a direct plan on a chat or scheduled turn, after the plan and before the pull request", () => {
      expect(step("push_direct")?.if).toBe(
        "steps.prepare.outputs.skip != 'true' && inputs.comment == '' && steps.plan.outputs.target == 'direct'",
      );
      expect(ids.indexOf("plan")).toBeLessThan(ids.indexOf("push_direct"));
      expect(ids.indexOf("push_direct")).toBeLessThan(ids.indexOf("pr"));
      expect(step("push_direct")?.["continue-on-error"]).toBe(true);
    });

    it("opens the usual pull request when the push fell back, like push-existing", () => {
      const condition = step("pr")?.if ?? "";
      expect(condition).toContain("steps.push_direct.outputs.fallback == 'true'");
      expect(condition).toContain("steps.push_existing.outputs.fallback == 'true'");
      expect(condition).toContain("steps.plan.outputs.target == 'thread'");
    });

    it("reports a failed push step to finish and hands it the direct outcome", () => {
      const finishEnv = stepsWithEnv(steps, "PULL_REQUEST_FAILED")[0]?.env;
      expect(finishEnv?.PULL_REQUEST_FAILED).toContain("steps.push_direct.outcome == 'failure'");
      expect(Object.keys(finishEnv ?? {})).toEqual(
        expect.arrayContaining([
          "DIRECT_PUSH",
          "DIRECT_BRANCH",
          "DIRECT_COMMIT_SHA",
          "DIRECT_FALLBACK_REASON",
        ]),
      );
    });

    it("never reads the target from the agent or the turn state", () => {
      const names = Object.keys(step("push_direct")?.env ?? {});
      expect(names).toEqual([
        "PR_TITLE",
        "RUN_URL",
        "CENTAUR_CONFIG_ROOT",
        "CENTAUR_ROOT",
        "GITHUB_TOKEN",
      ]);
    });
  });
});
