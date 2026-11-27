import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export interface ActionStep {
  id?: string;
  name?: string;
  "continue-on-error"?: boolean;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Action {
  inputs?: Record<string, { default?: string }>;
  runs: { steps: ActionStep[] };
}

export const loadAction = (name: string): Action =>
  parse(readFileSync(`.github/actions/${name}/action.yml`, "utf8"));

export const stepsWithEnv = (steps: ActionStep[], name: string) =>
  steps.filter((step) => step.env?.[name] !== undefined);

export const actionNames = () => readdirSync(".github/actions");

/** The env of every composite-action step that runs `node "$CENTAUR_CLI" <command>`. */
export const stepEnvsRunning = (command: string) =>
  actionNames().flatMap((name) =>
    loadAction(name)
      .runs.steps.filter((step) => step.run === `node "$CENTAUR_CLI" ${command}`)
      .map((step) => step.env ?? {}),
  );

export interface WorkflowInput {
  type?: string;
  default?: number | string | boolean;
  required?: boolean;
}

export interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  strategy?: { matrix?: { root?: string[] } };
  "timeout-minutes"?: number | string;
  steps?: { if?: string; uses?: string }[];
}

export interface Workflow {
  on?: {
    push?: { paths?: string[] };
    workflow_call?: { inputs?: Record<string, WorkflowInput> };
  };
  jobs: Record<string, WorkflowJob>;
}

export const loadWorkflow = (file: string): Workflow =>
  parse(readFileSync(`.github/workflows/${file}`, "utf8"));

/** Effective default `timeout-minutes` of a job: a literal number, or the numeric default of the `workflow_call` input it references. */
export function defaultTimeoutMinutes(
  workflow: Workflow,
  job: WorkflowJob | undefined,
): number | undefined {
  const raw = job?.["timeout-minutes"];
  if (typeof raw === "number") return raw;
  const match =
    typeof raw === "string" ? /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(raw) : null;
  if (!match?.[1]) return undefined;
  const input = workflow.on?.workflow_call?.inputs?.[match[1]];
  return input?.type === "number" && typeof input.default === "number" ? input.default : undefined;
}
