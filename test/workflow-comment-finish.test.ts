import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { finish, notifyFailure } from "../src/workflows/finish.js";
import { createPullRequestWriter } from "../src/workflows/pull-request-comments.js";
import { pushChanges } from "../src/workflows/push.js";
import { REPLY_MARKER } from "../src/workflows/resolve.js";
import { createClone, git } from "./helpers/git-fixtures.js";
import { commentFinishSetup, PR_URL, PULL_REQUEST } from "./helpers/pr-comment-fixtures.js";
import { THREAD, THREAD_PREFIX } from "./helpers/workflow-fixtures.js";

const posts = (aws: { requests: { operation: string }[] }) =>
  aws.requests.filter((r) => r.operation === "post");

describe("finish in comment mode", () => {
  it("pushes, posts the marked reply, notes the chat thread and refreshes the link", async () => {
    const { aws, github, push, deps, writeExecution } = await commentFinishSetup({ pushed: 2 });
    await writeExecution({ structured_output: { reply: "Renamed.", pr_title: "Rename  plan" } });

    await finish(deps());

    expect(push).toHaveBeenCalledWith("Rename plan");
    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      `${REPLY_MARKER}\nRenamed.`,
      undefined,
    );
    expect(posts(aws)).toEqual([
      {
        operation: "post",
        bot: "sprout",
        threadId: THREAD,
        text: `Replied on ${PR_URL} and pushed 2 commits`,
      },
    ]);
    expect(aws.requests.map((r) => r.operation)).toEqual(["post", "link-pull-request"]);
    expect(aws.requests.at(-1)).toMatchObject({
      token: "oidc-jwt",
      threadId: THREAD,
      pullRequest: PULL_REQUEST,
    });
  });

  it("replies in the inline thread and falls back to a default commit message", async () => {
    const { github, push, deps, writeExecution } = await commentFinishSetup({
      state: { replyTo: 77 },
    });
    await writeExecution({ structured_output: { reply: "Fixed." } });

    await finish(deps());

    expect(push).toHaveBeenCalledWith("Address review comments");
    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      expect.any(String),
      77,
    );
  });

  it("notes a single commit without repeating the reply text in chat", async () => {
    const { aws, deps, writeExecution } = await commentFinishSetup({ pushed: 1 });
    await writeExecution({ structured_output: { reply: "secret reply text" } });

    await finish(deps());

    expect(JSON.stringify(aws.requests)).not.toContain("secret reply text");
    expect(posts(aws)[0]).toMatchObject({ text: `Replied on ${PR_URL} and pushed 1 commit` });
  });

  it("posts nothing for an ignored turn without changes", async () => {
    const { aws, github, deps, writeExecution } = await commentFinishSetup();
    await writeExecution({ structured_output: { ignore: true } });

    await finish(deps());

    expect(github.comment).not.toHaveBeenCalled();
    expect(posts(aws)).toEqual([]);
  });

  it("announces pushed commits of an ignored turn with a marked comment", async () => {
    const { aws, github, deps, writeExecution } = await commentFinishSetup({ pushed: 1 });
    await writeExecution({ structured_output: { ignore: true } });

    await finish(deps());

    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      `${REPLY_MARKER}\nPushed 1 commit.`,
      undefined,
    );
    expect(posts(aws)[0]).toMatchObject({ text: `Pushed 1 commit to ${PR_URL}` });
  });

  it("replies with no commits when nothing changed", async () => {
    const { aws, deps, writeExecution } = await commentFinishSetup();
    await writeExecution({ structured_output: { reply: "Nothing to change." } });

    await finish(deps());

    expect(posts(aws)[0]).toMatchObject({ text: `Replied on ${PR_URL}` });
  });

  it("does not advance the chat marker or clear reactions, but saves a resumable session", async () => {
    const { aws, home, deps, writeExecution } = await commentFinishSetup({
      state: { policy: "resume" },
    });
    await mkdir(join(home, "session"), { recursive: true });
    await writeFile(join(home, "session", "s1.jsonl"), "data");
    await writeExecution({ session_id: "s1", structured_output: { reply: "ok" } });

    await finish(deps());

    expect(aws.objects.get(`${THREAD_PREFIX}s1.jsonl`)).toBe("data");
    expect(aws.objects.has(`${THREAD_PREFIX}last-processed`)).toBe(false);
    expect(aws.requests.map((r) => r.operation)).not.toContain("unreact");
  });

  it("warns, naming only the error type, when the chat note fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { github, aws, deps, writeExecution } = await commentFinishSetup({ fail: "chat" });
    await writeExecution({ structured_output: { reply: "ok" } });

    await finish(deps());

    expect(github.comment).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("chat is down");
    expect(aws.requests.map((r) => r.operation)).toContain("link-pull-request");
    warn.mockRestore();
  });

  it("fails before posting when the push fails", async () => {
    const { github, deps, writeExecution } = await commentFinishSetup({ fail: "push" });
    await writeExecution({ structured_output: { reply: "ok" } });

    await expect(finish(deps())).rejects.toThrow("push rejected");
    expect(github.comment).not.toHaveBeenCalled();
  });

  it("rejects a state that is not a comment turn", async () => {
    const { deps, writeExecution } = await commentFinishSetup({ state: { mode: "reply" } });
    await writeExecution({ structured_output: { reply: "ok" } });

    await expect(finish(deps())).rejects.toThrow("comment turn state");
  });
});

describe("notifyFailure in comment mode", () => {
  it("tells the thread and the pull request, with the marker", async () => {
    const { aws, github, deps } = await commentFinishSetup({ state: { replyTo: 5 } });
    const { workspace, poster, comment } = deps();

    await notifyFailure({ workspace, poster, comment, runUrl: "https://run" });

    expect(posts(aws)[0]).toMatchObject({ threadId: THREAD });
    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      `${REPLY_MARKER}\nThat turn failed. Details are in the workflow run: https://run`,
      5,
    );
  });
});

describe("pushChanges", () => {
  it("commits and pushes working tree changes as the Actions bot", async () => {
    const { work, write, remoteLog } = await createClone();
    await write("plan.md", "basil\n");
    await write("new/file.md", "x");
    await write(".centaur-turn/prompt.md", "never committed");

    expect(await pushChanges(work, "Use basil")).toBe(1);

    expect(await remoteLog()).toBe("Use basil|github-actions[bot]\ninit|t\n");
    const files = await git(work, "ls-files");
    expect(files).not.toContain(".centaur-turn");
    expect(files).toContain("new/file.md");
  });

  it("never stages the turn directory when it is not ignored", async () => {
    const { work, write } = await createClone({ ignoreTurnDir: false });
    await write("plan.md", "basil\n");
    await write(".centaur-turn/prompt.md", "never committed");

    expect(await pushChanges(work, "Use basil")).toBe(1);
    expect(await git(work, "ls-files")).not.toContain(".centaur-turn");
  });

  it("pushes nothing when there are no changes", async () => {
    const { work, remoteLog } = await createClone();

    expect(await pushChanges(work, "unused")).toBe(0);
    expect(await remoteLog()).toBe("init|t\n");
  });

  it("pushes commits the agent made itself", async () => {
    const { work, write, remoteLog } = await createClone();
    await write("plan.md", "basil\n");
    await git(work, "commit", "-am", "agent commit");

    expect(await pushChanges(work, "unused")).toBe(1);
    expect(await remoteLog()).toContain("agent commit|t");
  });
});

describe("createPullRequestWriter", () => {
  const writer = () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 201 }));
    return {
      fetchImpl,
      writer: createPullRequestWriter("tok", "https://api.test", fetchImpl as typeof fetch),
    };
  };

  it("posts a conversation comment", async () => {
    const { fetchImpl, writer: w } = writer();
    await w.comment("octo/sprout", 12, "hello");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/repos/octo/sprout/issues/12/comments");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ body: "hello" }) });
  });

  it("replies in an inline thread", async () => {
    const { fetchImpl, writer: w } = writer();
    await w.comment("octo/sprout", 12, "hello", 77);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.test/repos/octo/sprout/pulls/12/comments/77/replies",
    );
  });

  it("reports only the status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret body", { status: 403 }));
    const w = createPullRequestWriter("tok", "https://api.test", fetchImpl as typeof fetch);
    await expect(w.comment("o/r", 1, "x")).rejects.toThrow("GitHub request failed (403)");
  });
});
