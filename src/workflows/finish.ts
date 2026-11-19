import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { threadKey } from "../thread-key.js";
import type { PosterClient, ThreadStore } from "./aws.js";
import { cleanBody, cleanTitle } from "./clean-text.js";
import { STATE_FILE, type TurnState } from "./prepare.js";
import { pullRequestDetails } from "./pull-request.js";
import type { PullRequestWriter } from "./pull-request-comments.js";
import { clearReactions } from "./reactions.js";
import { BRANCH_PREFIX, REPLY_MARKER } from "./resolve.js";

const DEFAULT_COMMIT_MESSAGE = "Address review comments";
const DEFAULT_NEW_TITLE = "Centaur agent changes";

const resultMessage = z.object({
  type: z.literal("result"),
  session_id: z.string().optional(),
  structured_output: z
    .object({
      reply: z.string().min(1).optional(),
      ignore: z.boolean().optional(),
      new_thread_title: z.string().min(1).optional(),
      pr_title: z.string().optional(),
      pr_body: z.string().optional(),
      pr_action: z.enum(["update", "new"]).optional(),
      existing_pr_number: z.number().int().positive().optional(),
    })
    .refine((output) => (output.reply !== undefined) !== (output.ignore === true)),
});

export function extractResult(executionFileText: string) {
  const entries = JSON.parse(executionFileText) as { type?: string }[];
  const last = entries.findLast((entry) => entry.type === "result");
  const parsed = resultMessage.safeParse(last);
  if (!parsed.success) throw new Error("the agent produced no structured reply");
  return {
    reply: parsed.data.structured_output.reply,
    title: parsed.data.structured_output.new_thread_title,
    prTitle: parsed.data.structured_output.pr_title,
    prBody: parsed.data.structured_output.pr_body,
    prAction: parsed.data.structured_output.pr_action,
    existingPr: parsed.data.structured_output.existing_pr_number,
    sessionId: parsed.data.session_id,
  };
}

export interface PullRequestLink {
  number?: number | undefined;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

/** Present when `pull_requests.comment_new` is on, so a comment turn may open its own pull request. */
export interface NewPullRequestDeps {
  runId: string;
  attempt: string;
  runUrl: string;
  push: (options: {
    branch: string;
    message: string;
    originalHeadSha: string;
  }) => Promise<{ stacked: boolean } | undefined>;
}

/** Present when the turn answers a pull request comment. */
export interface CommentFinishDeps {
  newPullRequest?: NewPullRequestDeps | undefined;
  repository: string;
  pullRequestUrl: string;
  github: PullRequestWriter;
  push: (message: string) => Promise<number>;
}

/** Present when the turn's changes were pushed to an existing pull request. */
export interface UpdatedPullRequestDeps {
  repository: string;
  runUrl: string;
  number: number;
  github: Pick<PullRequestWriter, "comment">;
}

export interface FinishDeps {
  updatedPullRequest?: UpdatedPullRequestDeps | undefined;
  /** Why the agent's chosen pull request was not updated; the usual pull request was opened. */
  fallbackReason?: string | undefined;
  comment?: CommentFinishDeps | undefined;
  workspace: string;
  executionFile: string;
  pullRequestUrl?: string | undefined;
  pullRequestLink?: PullRequestLink | undefined;
  poster: PosterClient;
  storeFor: (bot: string, threadId: string) => ThreadStore;
}

const readState = async (workspace: string) =>
  JSON.parse(await readFile(join(workspace, STATE_FILE), "utf8")) as TurnState;

async function deliver(
  poster: PosterClient,
  state: TurnState,
  text: string,
  title: string | undefined,
) {
  if (state.mode === "reply" && state.threadId) {
    await poster.call({ operation: "post", bot: state.bot, threadId: state.threadId, text });
    return state.threadId;
  }
  if (!state.start) throw new Error("the turn names no chat to start a thread in");
  const started = await poster.call<{ threadId: string }>({
    operation: "start-thread",
    bot: state.bot,
    text,
    ...state.start,
    ...(title ? { title } : {}),
  });
  return started.threadId;
}

async function deliverReply(
  deps: FinishDeps,
  state: TurnState,
  result: ReturnType<typeof extractResult>,
) {
  const { pullRequestUrl, updatedPullRequest, fallbackReason } = deps;
  const text = [
    result.reply,
    pullRequestUrl &&
      `${updatedPullRequest ? "Updated pull request" : "Pull request"}: ${pullRequestUrl}`,
    pullRequestUrl &&
      !updatedPullRequest &&
      fallbackReason &&
      result.existingPr !== undefined &&
      `Could not update #${result.existingPr} (${fallbackReason}); opened the usual pull request instead.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (text) return deliver(deps.poster, state, text, result.title);
  if (!state.threadId) throw new Error("the agent can only stay silent in an existing thread");
  return state.threadId;
}

/** Best-effort: leaves the title and body of the updated pull request alone. */
async function commentOnUpdatedPullRequest(
  updated: UpdatedPullRequestDeps,
  state: TurnState,
  result: ReturnType<typeof extractResult>,
) {
  const details = pullRequestDetails(
    state,
    updated.runUrl,
    { title: result.prTitle, body: result.prBody },
    "Updated",
  );
  try {
    await updated.github.comment(
      updated.repository,
      updated.number,
      `${REPLY_MARKER}\n**${details.title}**\n\n${details.body}`,
    );
  } catch (error) {
    console.warn(
      `::warning::could not comment on the updated pull request (${(error as Error).constructor.name})`,
    );
  }
}

/** Best-effort: a failure is reported as a warning naming only the error type. */
async function linkPullRequest(
  poster: PosterClient,
  link: PullRequestLink | undefined,
  bot: string,
  threadId: string,
) {
  if (!link || link.number === undefined) return;
  try {
    const token = await link.fetchToken();
    link.mask(token);
    await poster.call({
      operation: "link-pull-request",
      token,
      bot,
      threadId,
      pullRequest: link.number,
    });
  } catch (error) {
    console.warn(
      `::warning::could not link the pull request to its thread (${(error as Error).constructor.name})`,
    );
  }
}

/**
 * Pushes the turn's changes to a new branch and opens a pull request from it, stacked on the
 * original pull request's branch when that branch's head is an ancestor of the new one, otherwise
 * on the default branch. Returns undefined when the working tree has no changes.
 */
async function openNewPullRequest(
  comment: CommentFinishDeps,
  newPr: NewPullRequestDeps,
  state: { bot: string; threadId: string; pullRequest: number },
  result: ReturnType<typeof extractResult>,
) {
  const title = cleanTitle(result.prTitle);
  if (!title) {
    console.warn("::warning::pr_action new came without a pr_title; using a default title");
  }
  const original = await comment.github.head(comment.repository, state.pullRequest);
  const branch = `${BRANCH_PREFIX}${state.bot}-${threadKey(state.bot, state.threadId)}-${newPr.runId}-${newPr.attempt}`;
  const pushed = await newPr.push({
    branch,
    message: title || DEFAULT_NEW_TITLE,
    originalHeadSha: original.sha,
  });
  if (!pushed) return undefined;
  const base = pushed.stacked
    ? original.ref
    : await comment.github.defaultBranch(comment.repository);
  const description = cleanBody(result.prBody);
  const footer = [
    `Opened from a comment on #${state.pullRequest} in [this workflow run](${newPr.runUrl}).`,
    pushed.stacked && `Stacked on #${state.pullRequest}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return comment.github.createPullRequest(comment.repository, {
    title: title || DEFAULT_NEW_TITLE,
    body: description ? `${description}\n\n---\n\n${footer}` : footer,
    head: branch,
    base,
  });
}

const plural = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/**
 * Pushes the working tree changes, posts the marked reply on the pull request and a content-free
 * note in the chat thread. Returns the thread and the pull request the turn answered.
 */
async function finishComment(
  deps: FinishDeps,
  comment: CommentFinishDeps,
  state: TurnState,
  result: ReturnType<typeof extractResult>,
) {
  if (state.mode !== "comment" || !state.threadId || !state.pullRequest) {
    throw new Error("comment finish needs a comment turn state");
  }
  const asNew = result.prAction === "new" && comment.newPullRequest;
  const opened = asNew
    ? await openNewPullRequest(
        comment,
        asNew,
        { bot: state.bot, threadId: state.threadId, pullRequest: state.pullRequest },
        result,
      )
    : undefined;
  const pushed = asNew
    ? 0
    : await comment.push(cleanTitle(result.prTitle) || DEFAULT_COMMIT_MESSAGE);
  const body = asNew
    ? [
        result.reply,
        opened
          ? `Opened #${opened.number} for this.`
          : "There were no changes, so no pull request was opened.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : (result.reply ?? (pushed > 0 ? `Pushed ${plural(pushed)}.` : undefined));
  if (body) {
    await comment.github.comment(
      comment.repository,
      state.pullRequest,
      `${REPLY_MARKER}\n${body}`,
      state.replyTo,
    );
    const note = opened
      ? `Opened #${opened.number} from comment on #${state.pullRequest}: ${opened.url}`
      : result.reply
        ? `Replied on ${comment.pullRequestUrl}${pushed > 0 ? ` and pushed ${plural(pushed)}` : ""}`
        : `Pushed ${plural(pushed)} to ${comment.pullRequestUrl}`;
    try {
      await deps.poster.call({
        operation: "post",
        bot: state.bot,
        threadId: state.threadId,
        text: note,
      });
    } catch (error) {
      console.warn(
        `::warning::could not post the note to the chat thread (${(error as Error).constructor.name})`,
      );
    }
  }
  return { threadId: state.threadId, pullRequest: state.pullRequest, opened: opened?.number };
}

/** Drops a target field that does not apply to the turn's mode, warning without its content. */
function ignoreMisplacedTargets(state: TurnState, result: ReturnType<typeof extractResult>) {
  const comment = state.mode === "comment";
  const misplaced = comment ? "existing_pr_number" : "pr_action";
  if ((comment ? result.existingPr : result.prAction) === undefined) return result;
  console.warn(`::warning::ignoring ${misplaced}, which does not apply to this kind of turn`);
  return comment ? { ...result, existingPr: undefined } : { ...result, prAction: undefined };
}

export async function finish(deps: FinishDeps) {
  const state = await readState(deps.workspace);
  const result = ignoreMisplacedTargets(
    state,
    extractResult(await readFile(deps.executionFile, "utf8")),
  );
  let threadId: string;
  let link = deps.pullRequestLink;
  if (deps.comment) {
    const answered = await finishComment(deps, deps.comment, state, result);
    threadId = answered.threadId;
    link = link && { ...link, number: answered.pullRequest };
    if (link && answered.opened !== undefined) {
      await linkPullRequest(deps.poster, { ...link, number: answered.opened }, state.bot, threadId);
    }
  } else {
    if (deps.updatedPullRequest) {
      await commentOnUpdatedPullRequest(deps.updatedPullRequest, state, result);
      link = link && { ...link, number: undefined };
    }
    threadId = await deliverReply(deps, state, result);
  }
  await linkPullRequest(deps.poster, link, state.bot, threadId);

  const store = deps.storeFor(state.bot, threadId);
  if (state.marker) await store.writeMarker(state.marker);
  if (state.policy === "resume" && result.sessionId) {
    await store.saveSession(state.sessionDirectory, result.sessionId);
  }
  await clearReactions(deps.poster, state.source);
}

export async function notifyFailure(
  deps: Pick<FinishDeps, "workspace" | "poster"> & {
    runUrl: string;
    comment?: Pick<CommentFinishDeps, "repository" | "github"> | undefined;
  },
) {
  const state = await readState(deps.workspace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!state) return;
  const text = `That turn failed. Details are in the workflow run: ${deps.runUrl}`;
  try {
    if (state.threadId && (state.mode === "reply" || state.mode === "comment")) {
      await deps.poster.call({ operation: "post", bot: state.bot, threadId: state.threadId, text });
    }
    if (state.mode === "comment" && state.pullRequest && deps.comment) {
      await deps.comment.github.comment(
        deps.comment.repository,
        state.pullRequest,
        `${REPLY_MARKER}\n${text}`,
        state.replyTo,
      );
    }
  } finally {
    await clearReactions(deps.poster, state.source);
  }
}
