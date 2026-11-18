import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE } from "../src/workflows/prepare.js";
import { replySchema } from "../src/workflows/prompt.js";
import {
  cleanTitle,
  describePullRequest,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  pullRequestDetails,
} from "../src/workflows/pull-request.js";
import { RUN_URL, turnState, writePullRequestTurn } from "./helpers/pull-request-fixtures.js";

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
    const schema = replySchema(false);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["pr_title", "pr_body"]));
    expect(schema.required).toEqual(["reply"]);
  });
});
