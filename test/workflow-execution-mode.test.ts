import { describe, expect, it } from "vitest";
import { prepare } from "../src/workflows/prepare.js";
import { buildPrompt, replySchema } from "../src/workflows/prompt.js";
import {
  DIRECT_CONFIG,
  flat,
  LEGACY_PR_BODY,
  LEGACY_PR_TITLE,
  LEGACY_PULL_REQUEST_STATEMENTS,
  PULL_REQUEST_CONFIG,
  readPromptText,
  SECTION_HEADING,
  schemaOf,
} from "./helpers/execution-mode-fixtures.js";
import { commitFile, createClone } from "./helpers/git-fixtures.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import { setup } from "./helpers/turn-fixtures.js";
import { message, schemaOptions } from "./helpers/workflow-fixtures.js";

const CHAT = { messages: [message("1", "hi")] };
const COMMIT_WORDING = 'Write "pr_title" as the commit message and "pr_body" as its body';

describe("the pull_request prompt", () => {
  it.each([
    ["without a mode", {}],
    ["with the mode", { executionMode: "pull_request" as const }],
  ])("keeps every statement it had before the section existed, %s", (_name, parts) => {
    const prompt = flat(buildPrompt({ ...CHAT, ...parts }));

    for (const statement of LEGACY_PULL_REQUEST_STATEMENTS) expect(prompt).toContain(statement);
    expect(prompt.split(SECTION_HEADING)).toHaveLength(2);
    expect(prompt).not.toContain(COMMIT_WORDING);
  });

  it("states where changes land once, for a scheduled turn too", () => {
    const prompt = buildPrompt({ scheduledTask: "Weekly tasks" });

    expect(prompt.split("a pull request is opened for you afterwards")).toHaveLength(2);
  });

  it("keeps the default reply schema fields and descriptions", () => {
    const { properties } = replySchema(schemaOptions());

    expect(Object.keys(properties)).toEqual(["reply", "new_thread_title", "pr_title", "pr_body"]);
    expect(properties).toMatchObject({
      pr_title: { description: LEGACY_PR_TITLE },
      pr_body: { description: LEGACY_PR_BODY },
    });
    expect(replySchema(schemaOptions({ executionMode: "pull_request" }))).toEqual(
      replySchema(schemaOptions()),
    );
  });
});

describe("the direct prompt", () => {
  it("describes a commit to the default branch instead of a pull request", () => {
    const prompt = flat(buildPrompt({ ...CHAT, executionMode: "direct" }));

    expect(prompt.split(SECTION_HEADING)).toHaveLength(2);
    expect(prompt).toContain("Edit files in the working tree only;");
    expect(prompt).toContain("commits them to the repository's default branch");
    expect(prompt).toContain("no review and no CI run");
    expect(prompt).toContain(COMMIT_WORDING);
    expect(prompt).toContain("change only what the request asks for, and do not guess");
    expect(prompt).toContain("If the push is rejected the harness opens a pull request instead");
    expect(prompt).not.toContain("a pull request is opened for you afterwards");
    expect(prompt).not.toContain("reviewer");
  });

  it("drops the pull request target fields and words the title and body as a commit", () => {
    const { properties } = replySchema(
      schemaOptions({ executionMode: "direct", allowExisting: true, canStaySilent: true }),
    );

    expect(Object.keys(properties)).toEqual([
      "reply",
      "new_thread_title",
      "pr_title",
      "pr_body",
      "ignore",
    ]);
    expect(properties.pr_title?.description).toContain("commit message");
    expect(properties.pr_body?.description).toContain("commit message body");
  });
});

describe("prepare", () => {
  it("tells a direct bot the mode and offers the matching schema", async () => {
    const run = await setup([message("1", "hi")], DIRECT_CONFIG);

    const out = await prepare(run.deps());

    const text = await readPromptText(run.root);
    expect(text).toContain(SECTION_HEADING);
    expect(text).toContain(COMMIT_WORDING);
    const { properties } = schemaOf(out.claude_args);
    expect(properties).not.toHaveProperty("existing_pr_number");
    expect(properties.pr_title?.description).toContain("commit message");
  });

  it("tells a pull_request bot the pull request wording", async () => {
    const run = await setup([message("1", "hi")], PULL_REQUEST_CONFIG);

    const out = await prepare(run.deps());

    const text = await readPromptText(run.root);
    for (const statement of LEGACY_PULL_REQUEST_STATEMENTS) expect(text).toContain(statement);
    expect(schemaOf(out.claude_args).properties.pr_title?.description).toBe(LEGACY_PR_TITLE);
  });

  it("keeps the pull request wording on a comment turn of a direct bot", async () => {
    const run = await commentSetup({
      comments: [prComment(1, "rename it")],
      config: DIRECT_CONFIG,
    });

    const out = await prepare(run.deps());

    const text = await readPromptText(run.root);
    expect(text).not.toContain(SECTION_HEADING);
    expect(text).not.toContain(COMMIT_WORDING);
    expect(schemaOf(out.claude_args).properties.pr_title?.description).toBe(LEGACY_PR_TITLE);
  });

  it("follows the config committed at HEAD, not a workspace file edited to direct", async () => {
    const { work, write } = await createClone();
    await commitFile(work, ".centaur.yml", PULL_REQUEST_CONFIG);
    await write(".centaur.yml", DIRECT_CONFIG);
    const run = await setup([message("1", "hi")], DIRECT_CONFIG);

    const out = await prepare(run.deps({ workspace: work }));

    const text = await readPromptText(work);
    expect(text).toContain("a pull request is opened for you afterwards");
    expect(text).not.toContain(COMMIT_WORDING);
    expect(schemaOf(out.claude_args).properties.pr_title?.description).toBe(LEGACY_PR_TITLE);
  });
});
