import { describe, expect, it } from "vitest";
import { loadAction, stepsWithEnv } from "./action-fixtures.js";

describe.each([
  ["register", ["Register the bot"]],
  ["resolve-pr-comment", ["resolve"]],
  ["resolve-schedule", ["resolve"]],
])("the %s action", (name, readers) => {
  const action = loadAction(name);

  it("defaults the root input to the repository root", () => {
    expect(action.inputs?.root?.default).toBe(".");
  });

  it("passes the root input to the step that reads the config as CENTAUR_ROOT", () => {
    const withRoot = stepsWithEnv(action.runs.steps, "CENTAUR_ROOT");
    expect(withRoot.map((step) => step.id ?? step.name)).toEqual(readers);
    for (const step of withRoot) expect(step.env?.CENTAUR_ROOT).toMatch(/inputs\.root/);
  });
});
