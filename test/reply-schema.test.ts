import { describe, expect, it } from "vitest";
import { replySchema } from "../src/workflows/prompt.js";
import { schemaOptions } from "./helpers/workflow-fixtures.js";

describe("replySchema", () => {
  it.each([
    [
      "every field of a chat turn",
      { canStaySilent: true, allowExisting: true, suspendable: ["a"] },
    ],
    [
      "every field of a comment turn",
      { mode: "comment" as const, canStaySilent: true, allowNewPr: true },
    ],
  ])("describes %s", (_name, overrides) => {
    const { properties } = replySchema(schemaOptions(overrides));

    expect(Object.keys(properties).length).toBeGreaterThanOrEqual(6);
    for (const [field, schema] of Object.entries(properties)) {
      expect(schema, field).toHaveProperty("description", expect.stringMatching(/\S/));
    }
  });
});
