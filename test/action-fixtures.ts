import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ActionStep {
  id?: string;
  name?: string;
  "continue-on-error"?: boolean;
  if?: string;
  env?: Record<string, string>;
}

interface Action {
  inputs?: Record<string, { default?: string }>;
  runs: { steps: ActionStep[] };
}

export const loadAction = (name: string): Action =>
  parse(readFileSync(`.github/actions/${name}/action.yml`, "utf8"));

export const stepsWithEnv = (steps: ActionStep[], name: string) =>
  steps.filter((step) => step.env?.[name] !== undefined);
