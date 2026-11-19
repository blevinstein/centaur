import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { threadKey } from "../src/thread-key.js";
import { finish, notifyFailure } from "../src/workflows/finish.js";
import { createPullRequestWriter } from "../src/workflows/pull-request-comments.js";
import { pushChanges, pushNewBranch } from "../src/workflows/push.js";
import { REPLY_MARKER } from "../src/workflows/resolve.js";
import { createClone, git } from "./helpers/git-fixtures.js";
import {
  commentFinishSetup,
  HEAD_REF,
  NEW_PR_URL,
  NEW_PULL_REQUEST,
  ORIGINAL_SHA,
  PR_URL,
  PULL_REQUEST,
  RUN_URL,
} from "./helpers/pr-comment-fixtures.js";
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

  it("ignores existing_pr_number in a comment turn with a content-free warning", async () => {
    const { deps, writeExecution } = await commentFinishSetup();
    await writeExecution({ structured_output: { reply: "Done.", existing_pr_number: 12 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await finish(deps());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("::warning::ignoring"));
    expect(warn.mock.calls.flat().join()).not.toContain("12");
    warn.mockRestore();
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

describe("finish in comment mode with pr_action new", () => {
  const newOutput = {
    reply: "Split out.",
    pr_action: "new",
    pr_title: "Add  basil",
    pr_body: "Why.",
  };

  it("opens a stacked pull request, replies, notes the chat and links both pull requests", async () => {
    const { aws, github, push, pushNew, deps, writeExecution } = await commentFinishSetup({
      newPr: { stacked: true },
      state: { replyTo: 77 },
    });
    await writeExecution({ structured_output: newOutput });

    await finish(deps());

    const branch = `centaur/sprout-${threadKey("sprout", THREAD)}-99-2`;
    expect(push).not.toHaveBeenCalled();
    expect(pushNew).toHaveBeenCalledWith({
      branch,
      message: "Add basil",
      originalHeadSha: ORIGINAL_SHA,
    });
    expect(github.createPullRequest).toHaveBeenCalledWith("octo/sprout", {
      title: "Add basil",
      body: `Why.\n\n---\n\nOpened from a comment on #12 in [this workflow run](${RUN_URL}). Stacked on #12.`,
      head: branch,
      base: HEAD_REF,
    });
    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      `${REPLY_MARKER}\nSplit out.\n\nOpened #${NEW_PULL_REQUEST} for this.`,
      77,
    );
    expect(posts(aws)).toEqual([
      {
        operation: "post",
        bot: "sprout",
        threadId: THREAD,
        text: `Opened #${NEW_PULL_REQUEST} from comment on #12: ${NEW_PR_URL}`,
      },
    ]);
    const links = aws.requests.filter((r) => r.operation === "link-pull-request");
    expect(links.map((r) => r.pullRequest)).toEqual([NEW_PULL_REQUEST, PULL_REQUEST]);
    expect(JSON.stringify(aws.requests)).not.toContain("Split out.");
  });

  it("bases the pull request on the default branch when it is not stacked", async () => {
    const { github, deps, writeExecution } = await commentFinishSetup({
      newPr: { stacked: false },
    });
    await writeExecution({ structured_output: { reply: "Done.", pr_action: "new" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await finish(deps());

    expect(github.createPullRequest).toHaveBeenCalledWith(
      "octo/sprout",
      expect.objectContaining({
        title: "Centaur agent changes",
        base: "main",
        body: `Opened from a comment on #12 in [this workflow run](${RUN_URL}).`,
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a pr_title"));
    warn.mockRestore();
  });

  it("opens no pull request when there are no changes, but still replies", async () => {
    const { aws, github, deps, writeExecution } = await commentFinishSetup({
      newPr: "no-changes",
    });
    await writeExecution({ structured_output: newOutput });

    await finish(deps());

    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.comment).toHaveBeenCalledWith(
      "octo/sprout",
      PULL_REQUEST,
      `${REPLY_MARKER}\nSplit out.\n\nThere were no changes, so no pull request was opened.`,
      undefined,
    );
    expect(posts(aws)[0]).toMatchObject({ text: `Replied on ${PR_URL}` });
    expect(aws.requests.filter((r) => r.operation === "link-pull-request")).toHaveLength(1);
  });

  it("fails the turn before opening or replying when the push fails", async () => {
    const { github, deps, writeExecution } = await commentFinishSetup({
      newPr: { stacked: true },
      fail: "push",
    });
    await writeExecution({ structured_output: newOutput });

    await expect(finish(deps())).rejects.toThrow("push rejected");
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.comment).not.toHaveBeenCalled();
  });

  it("keeps the update behavior when comment_new is off", async () => {
    const { github, push, deps, writeExecution } = await commentFinishSetup({ pushed: 1 });
    await writeExecution({ structured_output: newOutput });

    await finish(deps());

    expect(push).toHaveBeenCalledWith("Add basil");
    expect(github.createPullRequest).not.toHaveBeenCalled();
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

describe("pushNewBranch", () => {
  const NEW = "centaur/branch-99-1";
  const headSha = async (work: string) => (await git(work, "rev-parse", "HEAD")).trim();

  it("pushes a new branch as the Actions bot and leaves the original branch alone", async () => {
    const { work, write, remoteLog } = await createClone();
    const originalHeadSha = await headSha(work);
    await write("plan.md", "basil\n");
    await write(".centaur-turn/prompt.md", "never committed");
    await write(".centaur-trusted/x.md", "never committed");

    const pushed = await pushNewBranch(work, {
      branch: NEW,
      message: "Use basil",
      originalHeadSha,
    });

    expect(pushed).toEqual({ stacked: true });
    expect(await remoteLog(NEW)).toBe("Use basil|github-actions[bot]\ninit|t\n");
    expect(await remoteLog()).toBe("init|t\n");
    const files = await git(work, "ls-files");
    expect(files).not.toContain(".centaur-turn");
    expect(files).not.toContain(".centaur-trusted");
  });

  it("is not stacked when the original head is not an ancestor", async () => {
    const { work, write } = await createClone();
    const originalHeadSha = await headSha(work);
    await git(work, "commit", "--amend", "-m", "rewritten");
    await write("plan.md", "basil\n");

    expect(await pushNewBranch(work, { branch: NEW, message: "m", originalHeadSha })).toEqual({
      stacked: false,
    });
  });

  it("pushes commits the agent made itself", async () => {
    const { work, write, remoteLog } = await createClone();
    const originalHeadSha = await headSha(work);
    await write("plan.md", "basil\n");
    await git(work, "commit", "-am", "agent commit");

    expect(await pushNewBranch(work, { branch: NEW, message: "unused", originalHeadSha })).toEqual({
      stacked: true,
    });
    expect(await remoteLog(NEW)).toContain("agent commit|t");
  });

  it("does nothing when there are no changes", async () => {
    const { work, remote } = await createClone();
    const originalHeadSha = await headSha(work);

    expect(
      await pushNewBranch(work, { branch: NEW, message: "m", originalHeadSha }),
    ).toBeUndefined();
    expect(await git(remote, "branch", "--list", NEW)).toBe("");
  });

  it("fails when the push is rejected", async () => {
    const { work, write } = await createClone();
    const originalHeadSha = await headSha(work);
    await write("other.md", "x");
    await git(work, "add", "other.md");
    await git(work, "commit", "-m", "diverged");
    await git(work, "push", "origin", `HEAD:${NEW}`);
    await git(work, "reset", "--hard", originalHeadSha);
    await write("plan.md", "basil\n");

    await expect(
      pushNewBranch(work, { branch: NEW, message: "m", originalHeadSha }),
    ).rejects.toThrow();
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

  it("opens a pull request and reads the head and default branch", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).endsWith("/pulls")
        ? new Response(JSON.stringify({ number: 20, html_url: "https://x/pull/20" }), {
            status: 201,
          })
        : new Response(JSON.stringify({ default_branch: "trunk", head: { ref: "b", sha: "s" } })),
    );
    const w = createPullRequestWriter("tok", "https://api.test", fetchImpl as typeof fetch);

    const pullRequest = { title: "T", body: "B", head: "h", base: "b" };
    expect(await w.createPullRequest("octo/sprout", pullRequest)).toEqual({
      number: 20,
      url: "https://x/pull/20",
    });
    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://api.test/repos/octo/sprout/pulls",
      expect.objectContaining({ method: "POST", body: JSON.stringify(pullRequest) }),
    ]);
    expect(await w.head("octo/sprout", 12)).toEqual({ ref: "b", sha: "s" });
    expect(await w.defaultBranch("octo/sprout")).toBe("trunk");
  });

  it("reports only the status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret body", { status: 403 }));
    const w = createPullRequestWriter("tok", "https://api.test", fetchImpl as typeof fetch);
    await expect(w.comment("o/r", 1, "x")).rejects.toThrow("GitHub request failed (403)");
  });
});
