import { describe, expect, it } from "vitest";
import { botConcurrencyGroup } from "../src/workflows/bot-group.js";
import { PERSISTENT_FAN_OUT_CONFIG, persistentConfig } from "./helpers/turn-fixtures.js";
import {
  createRunnerEnv,
  readOutputs,
  runWorkflowCommand,
} from "./helpers/workflow-cli-fixtures.js";
import { configText } from "./helpers/workflow-fixtures.js";

describe("botConcurrencyGroup", () => {
  it("names only the bot", () => {
    expect(botConcurrencyGroup("sprout")).toBe("centaur-sprout");
  });

  it("differs by bot", () => {
    expect(botConcurrencyGroup("sprout")).not.toBe(botConcurrencyGroup("garden"));
  });
});

describe("resolve-schedule", () => {
  it.each([
    ["a new-thread prompt", configText("prompts: {weekly: {destination: household}}")],
    ["a persistent prompt", persistentConfig()],
    ["a persistent fan-out prompt", PERSISTENT_FAN_OUT_CONFIG],
  ])("outputs the bot's group for %s", async (_name, config) => {
    const { env, output } = await createRunnerEnv({ files: { ".centaur.yml": config } });

    await runWorkflowCommand("resolve-schedule", env);

    expect(await readOutputs(output)).toEqual({ group: "centaur-sprout" });
  });
});
