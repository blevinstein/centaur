import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractResult } from "../src/workflows/finish.js";
import { STATE_FILE } from "../src/workflows/prepare.js";
import { buildPrompt, replySchema } from "../src/workflows/prompt.js";
import {
  cleanTitle,
  describePullRequest,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  pullRequestDetails,
} from "../src/workflows/pull-request.js";
import { RUN_URL, turnState, writePullRequestTurn } from "./helpers/pull-request-fixtures.js";
import { executionText, schemaOptions } from "./helpers/workflow-fixtures.js";

describe("pullRequestDetails", () => {
  it("uses the agent's title and body, followed by a run link", () => {
    const details = pullRequestDetails(turnState(), RUN_URL, {
      title: "Fix schedule",
      body: "Moved the Tuesday task.",
    });

    expect(details.title).toBe("Fix schedule");
    expect(details.body).toMatch(/^Moved the Tuesday task\.\n\n---\n\n/);
    expect(details.body).toContain(`[this workflow run](${RUN_URL})`);
  });

  it("falls back to the prompt name or a constant title, and to a body that links the run", () => {
    const scheduled = pullRequestDetails(turnState({ promptName: "weekly" }), RUN_URL);
    expect(scheduled.title).toBe("Centaur agent changes: weekly");
    expect(scheduled.body).toContain("scheduled prompt `weekly`");

    const chat = pullRequestDetails(turnState({ threadId: "telegram:-100:7" }), RUN_URL, {
      title: "  \n ",
    });
    expect(chat.title).toBe("Centaur agent changes");
    expect(chat.body).toContain("chat turn");
    expect(chat.body).not.toContain("telegram");
  });

  it("words the footer for an update", () => {
    const details = pullRequestDetails(turnState({ promptName: "weekly" }), RUN_URL, {}, "Updated");

    expect(details.body).toMatch(/^Updated by the scheduled prompt `weekly`/);
  });

  it("flattens and bounds the title and bounds the body", () => {
    expect(cleanTitle("one\ntwo\r\n\tthree\u0000")).toBe("one two three");
    const details = pullRequestDetails(turnState(), RUN_URL, {
      title: "x".repeat(MAX_TITLE_LENGTH * 2),
      body: "y".repeat(MAX_BODY_LENGTH * 2),
    });
    expect(details.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(details.body.split("\n\n---\n\n")[0]).toHaveLength(MAX_BODY_LENGTH);
  });
});

describe("describePullRequest", () => {
  it("reads the agent's fields from the execution file", async () => {
    const { root, executionFile } = await writePullRequestTurn({
      structured_output: { reply: "Done.", pr_title: "Fix it", pr_body: "Because." },
    });

    const details = await describePullRequest({ workspace: root, executionFile, runUrl: RUN_URL });

    expect(details.title).toBe("Fix it");
    expect(details.body).toContain("Because.");
  });

  it.each([
    ["has no structured output", { structured_output: undefined }],
    ["omits the fields", { structured_output: { reply: "Done." } }],
  ])("falls back when the agent %s", async (_name, result) => {
    const { root, executionFile } = await writePullRequestTurn(result);

    const details = await describePullRequest({ workspace: root, executionFile, runUrl: RUN_URL });

    expect(details.title).toBe("Centaur agent changes");
    expect(details.body).toContain(RUN_URL);
  });

  it("falls back when the execution file is missing", async () => {
    const { root } = await writePullRequestTurn({});
    await writeFile(join(root, STATE_FILE), JSON.stringify(turnState()));

    const details = await describePullRequest({
      workspace: root,
      executionFile: join(root, "missing.json"),
      runUrl: RUN_URL,
    });

    expect(details.title).toBe("Centaur agent changes");
  });
});

describe("replySchema", () => {
  it("offers the pull request fields without requiring them", () => {
    const schema = replySchema(schemaOptions());
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["pr_title", "pr_body"]));
    expect(schema.required).toEqual(["reply"]);
  });

  it.each([
    ["comment", { allowNewPr: true }, "pr_action", { enum: ["update", "new"] }],
    ["reply", { allowExisting: true }, "existing_pr_number", { type: "integer", minimum: 1 }],
    [
      "start-thread",
      { allowExisting: true },
      "existing_pr_number",
      { type: "integer", minimum: 1 },
    ],
  ] as const)("adds the %s target field only when enabled", (mode, flags, field, expected) => {
    const schema = replySchema(schemaOptions({ mode, ...flags }));
    expect(schema.properties).toHaveProperty(field, expected);
    expect(schema.additionalProperties).toBe(false);
    expect(replySchema(schemaOptions({ mode })).properties).not.toHaveProperty(field);
  });

  it("omits the field that does not fit the mode", () => {
    const both = { allowNewPr: true, allowExisting: true };
    expect(replySchema(schemaOptions({ mode: "comment", ...both })).properties).not.toHaveProperty(
      "existing_pr_number",
    );
    expect(replySchema(schemaOptions({ mode: "reply", ...both })).properties).not.toHaveProperty(
      "pr_action",
    );
  });
});

describe("pull request target contract", () => {
  const comment = { pullRequest: { title: "t", body: "b", comments: "c" } };

  it("explains each field only when enabled", () => {
    expect(buildPrompt({ ...comment, allowNewPr: true })).toContain('"pr_action"');
    expect(buildPrompt(comment)).not.toContain("pr_action");
    expect(buildPrompt({ allowExisting: true })).toContain('"existing_pr_number"');
    expect(buildPrompt({})).not.toContain("existing_pr_number");
  });
});

describe("extractResult pull request targets", () => {
  it("returns the target fields", () => {
    expect(
      extractResult(executionText({ reply: "ok", pr_action: "new", existing_pr_number: 7 })),
    ).toMatchObject({ prAction: "new", existingPr: 7 });
    expect(extractResult(executionText({ reply: "ok" }))).toMatchObject({
      prAction: undefined,
      existingPr: undefined,
    });
  });

  it.each([
    { pr_action: "merge" },
    { existing_pr_number: 1.5 },
    { existing_pr_number: 0 },
    { existing_pr_number: "7" },
  ])("rejects %j", (bad) => {
    expect(() => extractResult(executionText({ reply: "ok", ...bad }))).toThrow(
      "no structured reply",
    );
  });
});
