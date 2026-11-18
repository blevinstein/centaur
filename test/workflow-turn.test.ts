import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finish, notifyFailure } from "../src/workflows/finish.js";
import { PROMPT_FILE, type PrepareDeps, prepare, STATE_FILE } from "../src/workflows/prepare.js";
import {
  botMessage,
  configText,
  createFakeAws,
  createWorkspace,
  message,
  THREAD,
  THREAD_PREFIX,
} from "./helpers/workflow-fixtures.js";

async function setup(messages: ReturnType<typeof message>[], config = configText()) {
  const aws = createFakeAws((request) => {
    if (request.operation === "read") return { messages };
    if (request.operation === "start-thread") return { threadId: "telegram:-100:99" };
    return { messageId: "m" };
  });
  const { root, home } = await createWorkspace({
    ".centaur.yml": config,
    ".centaur/persona.md": "Be kind.",
    ".centaur/prompts/weekly.md": "Post this week's tasks.",
  });
  const deps = (overrides: Partial<PrepareDeps> = {}): PrepareDeps => ({
    workspace: root,
    home,
    runId: "42",
    clientPayload: { bot: "sprout", thread_id: THREAD, message_id: "1" },
    poster: aws.poster,
    storeFor: aws.storeFor,
    ...overrides,
  });
  const executionFile = join(root, "execution.json");
  const writeExecution = (entry: object) =>
    writeFile(executionFile, JSON.stringify([{ type: "system" }, { type: "result", ...entry }]));
  return { aws, root, home, deps, executionFile, writeExecution };
}

const prompt = (root: string) => readFile(join(root, PROMPT_FILE), "utf8");
const state = async (root: string) => JSON.parse(await readFile(join(root, STATE_FILE), "utf8"));

describe("prepare", () => {
  it("assembles a transcript turn with persona, schema and tools", async () => {
    const { deps, root } = await setup([
      message("1", "old"),
      botMessage("2", "r"),
      message("3", "new"),
    ]);

    const out = await prepare(deps());

    expect(out).toMatchObject({
      skip: false,
      thread_id: THREAD,
      branch: "centaur/sprout-telegram--100-7",
    });
    expect(out.claude_args).toContain('--allowedTools "Read,Edit"');
    expect(out.claude_args).toContain("--append-system-prompt-file .centaur/persona.md");
    expect(out.claude_args).toContain("--json-schema");
    expect(out.claude_args).not.toContain("--resume");
    const text = await prompt(root);
    expect(text).toContain("Earlier messages in this thread");
    expect(text).toContain("Sam: new");
    expect(await state(root)).toMatchObject({ mode: "reply", policy: "transcript", marker: "3" });
  });

  it.each([
    ["mention", false],
    ["all", true],
  ])("with respond_to %s, the schema allows ignoring: %s", async (respondTo, canIgnore) => {
    const { deps, root } = await setup(
      [message("1", "hi")],
      configText(`respond_to: ${respondTo}`),
    );

    const out = await prepare(deps());

    expect(out.claude_args.includes('"ignore"')).toBe(canIgnore);
    expect((await prompt(root)).includes("stay silent")).toBe(canIgnore);
  });

  it("never offers silence for scheduled turns", async () => {
    const { deps, root } = await setup(
      [],
      configText("respond_to: all\nprompts: {weekly: {context: fresh}}"),
    );

    const out = await prepare(deps({ promptName: "weekly", clientPayload: undefined }));

    expect(out.claude_args).not.toContain('"ignore"');
    expect(await prompt(root)).not.toContain("stay silent");
  });

  it("adds a scoped Read rule when the allowlist lacks Read, and honors the model", async () => {
    const { deps } = await setup(
      [message("1", "hi")],
      configText("model: sonnet").replace("Read,Edit", "Edit"),
    );
    const out = await prepare(deps());
    expect(out.claude_args).toContain("--model sonnet");
    expect(out.claude_args).toContain('"Edit,Read(./.centaur-turn/**)"');
  });

  it("gives a fresh turn only the pending messages", async () => {
    const { deps, root } = await setup(
      [message("1", "old"), botMessage("2", "r"), message("3", "new")],
      configText("context: {default: fresh}"),
    );
    await prepare(deps());
    expect(await prompt(root)).not.toContain("Earlier messages");
  });

  it("skips when the marker shows everything was processed", async () => {
    const { deps, aws } = await setup([message("1", "hi")]);
    aws.objects.set(`${THREAD_PREFIX}last-processed`, "1");
    expect(await prepare(deps())).toMatchObject({ skip: true });
  });

  it("resumes a stored session instead of rendering history", async () => {
    const { deps, aws, root, home } = await setup([
      message("1", "old"),
      botMessage("2", "r"),
      message("3", "/resume continue"),
    ]);
    aws.objects.set(`${THREAD_PREFIX}abc123.jsonl`, "session");

    const out = await prepare(deps());

    expect(out.claude_args).toContain("--resume abc123");
    expect(await prompt(root)).not.toContain("Earlier messages");
    const dir = (await state(root)).sessionDirectory as string;
    expect(dir.startsWith(home)).toBe(true);
    expect(await readFile(join(dir, "abc123.jsonl"), "utf8")).toBe("session");
  });

  it("renders history on the first resume turn when no session exists", async () => {
    const { deps, root } = await setup([
      message("1", "old"),
      botMessage("2", "r"),
      message("3", "/resume go"),
    ]);
    const out = await prepare(deps());
    expect(out.claude_args).not.toContain("--resume");
    expect(await prompt(root)).toContain("Earlier messages");
  });

  it("acknowledges a bare policy command and marks it processed", async () => {
    const { deps, aws } = await setup([message("1", "/transcript")]);
    expect(await prepare(deps())).toMatchObject({ skip: true });
    expect(aws.requests.at(-1)).toMatchObject({ operation: "post", threadId: THREAD });
    expect(aws.objects.get(`${THREAD_PREFIX}last-processed`)).toBe("1");
  });

  it("answers /new in the old thread and runs the seed in a new one", async () => {
    const { deps, aws, root } = await setup([message("1", "/new tomatoes")]);
    const out = await prepare(deps());
    expect(out).toMatchObject({ skip: false, thread_id: "" });
    expect(aws.requests.at(-1)).toMatchObject({ operation: "post", text: "Started a new thread." });
    expect(await state(root)).toMatchObject({ mode: "start-thread" });
    expect(await prompt(root)).toContain("tomatoes");
  });

  it("opens an empty thread for a bare /new without running the agent", async () => {
    const { deps, aws } = await setup([message("1", "/new")]);
    expect(await prepare(deps())).toMatchObject({ skip: true });
    expect(aws.requests.map((r) => r.operation)).toEqual(["read", "post", "start-thread"]);
  });

  it("builds a scheduled turn from the named prompt", async () => {
    const { deps, root } = await setup([], configText("prompts: {weekly: {context: resume}}"));
    const out = await prepare(deps({ promptName: "weekly", clientPayload: undefined }));
    expect(out.branch).toBe("centaur/sprout-weekly-42");
    expect(await prompt(root)).toContain("Post this week's tasks.");
    expect(await state(root)).toMatchObject({ mode: "start-thread", policy: "resume" });
  });

  it.each([
    ["an unknown prompt", { promptName: "nope" }, /no prompt named "nope"/],
    ["a dispatch for another bot", { clientPayload: { bot: "other", thread_id: THREAD } }, /other/],
  ])("rejects %s", async (_name, overrides, error) => {
    const { deps } = await setup([message("1", "hi")]);
    await expect(prepare(deps(overrides))).rejects.toThrow(error);
  });

  it("reports config problems", async () => {
    const { deps } = await setup([], "bot: Bad");
    await expect(prepare(deps())).rejects.toThrow(/\.centaur\.yml is invalid[\s\S]*bot/);
  });
});

describe("finish", () => {
  it("posts the reply with the PR link, advances the marker and saves the session", async () => {
    const { deps, aws, root, executionFile, writeExecution } = await setup(
      [message("1", "hi")],
      configText("context: {default: resume}"),
    );
    await prepare(deps());
    await writeFile(join((await state(root)).sessionDirectory, "s1.jsonl"), "data");
    await writeExecution({ session_id: "s1", structured_output: { reply: "Done." } });

    await finish({
      workspace: root,
      executionFile,
      pullRequestUrl: "https://example.test/pr/1",
      poster: aws.poster,
      storeFor: aws.storeFor,
    });

    expect(aws.requests.at(-1)).toMatchObject({
      operation: "post",
      threadId: THREAD,
      text: "Done.\n\nPull request: https://example.test/pr/1",
    });
    expect(aws.objects.get(`${THREAD_PREFIX}last-processed`)).toBe("1");
    expect(aws.objects.get(`${THREAD_PREFIX}s1.jsonl`)).toBe("data");
  });

  it("starts a thread for scheduled turns and keys the session by the new thread", async () => {
    const { deps, aws, root, executionFile, writeExecution } = await setup(
      [],
      configText("prompts: {weekly: {context: resume}}"),
    );
    const out = await prepare(deps({ promptName: "weekly", clientPayload: undefined }));
    expect(out.claude_args).not.toContain("--resume");
    const { sessionDirectory } = await state(root);
    await writeFile(join(sessionDirectory, "s2.jsonl"), "data");
    await writeExecution({
      session_id: "s2",
      structured_output: { reply: "Tasks", new_thread_title: "Week 47" },
    });

    await finish({ workspace: root, executionFile, poster: aws.poster, storeFor: aws.storeFor });

    expect(aws.requests.at(-1)).toMatchObject({
      operation: "start-thread",
      text: "Tasks",
      title: "Week 47",
    });
    expect(aws.objects.get("sessions/sprout/telegram_-100_99/s2.jsonl")).toBe("data");
  });

  it("posts nothing when the agent ignores the messages, but advances the marker and saves the session", async () => {
    const { deps, aws, root, executionFile, writeExecution } = await setup(
      [message("1", "lunch?")],
      configText("respond_to: all\ncontext: {default: resume}"),
    );
    await prepare(deps());
    await writeFile(join((await state(root)).sessionDirectory, "s3.jsonl"), "data");
    await writeExecution({ session_id: "s3", structured_output: { ignore: true } });

    await finish({
      workspace: root,
      executionFile,
      pullRequestUrl: "https://example.test/pr/1",
      poster: aws.poster,
      storeFor: aws.storeFor,
    });

    expect(aws.requests.map((r) => r.operation)).toEqual(["read"]);
    expect(aws.objects.get(`${THREAD_PREFIX}last-processed`)).toBe("1");
    expect(aws.objects.get(`${THREAD_PREFIX}s3.jsonl`)).toBe("data");
  });

  it.each([
    ["both a reply and ignore", { reply: "Hi", ignore: true }],
    ["neither a reply nor ignore", { new_thread_title: "t" }],
    ["ignore false without a reply", { ignore: false }],
  ])("fails when the output has %s", async (_name, output) => {
    const { deps, aws, root, executionFile, writeExecution } = await setup([message("1", "hi")]);
    await prepare(deps());
    await writeExecution({ structured_output: output });
    await expect(
      finish({ workspace: root, executionFile, poster: aws.poster, storeFor: aws.storeFor }),
    ).rejects.toThrow(/no structured reply/);
  });

  it("refuses to stay silent when there is no thread to stay silent in", async () => {
    const { deps, aws, root, executionFile, writeExecution } = await setup(
      [],
      configText("prompts: {weekly: {}}"),
    );
    await prepare(deps({ promptName: "weekly", clientPayload: undefined }));
    await writeExecution({ structured_output: { ignore: true } });
    await expect(
      finish({ workspace: root, executionFile, poster: aws.poster, storeFor: aws.storeFor }),
    ).rejects.toThrow(/stay silent/);
  });

  it("fails without a structured reply", async () => {
    const { deps, aws, root, executionFile, writeExecution } = await setup([message("1", "hi")]);
    await prepare(deps());
    await writeExecution({ structured_output: {} });
    await expect(
      finish({ workspace: root, executionFile, poster: aws.poster, storeFor: aws.storeFor }),
    ).rejects.toThrow(/no structured reply/);
    expect(aws.requests.map((r) => r.operation)).toEqual(["read"]);
  });
});

describe("notifyFailure", () => {
  it("posts a generic notice without touching the marker", async () => {
    const { deps, aws, root } = await setup([message("1", "hi")]);
    await prepare(deps());
    await notifyFailure({
      workspace: root,
      poster: aws.poster,
      runUrl: "https://example.test/run/1",
    });
    expect(aws.requests.at(-1)).toMatchObject({
      operation: "post",
      text: expect.stringContaining("https://example.test/run/1"),
    });
    expect(aws.objects.size).toBe(0);
  });
});
