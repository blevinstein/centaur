import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfigOrThrow } from "../src/workflows/config-file.js";
import { scheduleGroup } from "../src/workflows/schedule-group.js";
import {
  PERSISTENT_FAN_OUT_CONFIG,
  persistentConfig,
  scheduleGroupOf,
} from "./helpers/turn-fixtures.js";
import { configText } from "./helpers/workflow-fixtures.js";

describe("scheduleGroup", () => {
  it("is stable across runs of a persistent prompt and hashes the destination name", () => {
    const first = scheduleGroupOf(persistentConfig());
    expect(first).toMatch(/^centaur-sprout-[0-9a-f]{12}$/);
    expect(scheduleGroupOf(persistentConfig(), "43")).toBe(first);
    expect(first).not.toContain("household");
  });

  it("differs by destination and by the set of targets", () => {
    const other = persistentConfig().replace("household", "garden");
    expect(
      new Set([
        scheduleGroupOf(persistentConfig()),
        scheduleGroupOf(other),
        scheduleGroupOf(PERSISTENT_FAN_OUT_CONFIG),
      ]).size,
    ).toBe(3);
  });

  it("is unique per run for a prompt that opens a new thread each time", () => {
    const text = configText("prompts: {weekly: {destination: household}}");
    expect(scheduleGroupOf(text)).toBe("centaur-sprout-weekly-42");
  });

  it("rejects a prompt the config does not define", () => {
    expect(() => scheduleGroup(parseConfigOrThrow(persistentConfig()), "nope", "1")).toThrow(
      /no prompt named "nope"/,
    );
  });
});

describe("the scheduled caller workflow", () => {
  const workflow = parse(readFileSync(".github/workflows/centaur-hello.yml", "utf8"));
  const action = parse(readFileSync(".github/actions/resolve-schedule/action.yml", "utf8"));

  it("serializes the turn job on the group its resolve job computes", () => {
    expect(workflow.jobs.hello.needs).toBe("resolve");
    expect(workflow.jobs.hello.concurrency.group).toMatch(
      /^\$\{\{ needs\.resolve\.outputs\.group \}\}$/,
    );
    expect(workflow.jobs.resolve.outputs.group).toMatch(
      /^\$\{\{ steps\.resolve\.outputs\.group \}\}$/,
    );
  });

  it("gives the resolve action the same prompt name as the turn step", () => {
    const step = workflow.jobs.resolve.steps.find((s: { id?: string }) => s.id === "resolve");
    const turn = workflow.jobs.hello.steps.find((s: { uses?: string }) =>
      s.uses?.endsWith("/actions/turn"),
    );
    expect(step.with.prompt_name).toBe(turn.with.prompt_name);
    expect(
      action.runs.steps.find((s: { id?: string }) => s.id === "resolve").env.PROMPT_NAME,
    ).toMatch(/^\$\{\{ inputs\.prompt_name \}\}$/);
    expect(action.outputs.group.value).toMatch(/^\$\{\{ steps\.resolve\.outputs\.group \}\}$/);
  });
});
