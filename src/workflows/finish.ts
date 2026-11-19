import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PosterClient, ThreadStore } from "./aws.js";
import { cleanTitle } from "./clean-text.js";
import { STATE_FILE, type TurnState } from "./prepare.js";
import type { PullRequestWriter } from "./pull-request-comments.js";
import { clearReactions } from "./reactions.js";
import { REPLY_MARKER } from "./resolve.js";

const DEFAULT_COMMIT_MESSAGE = "Address review comments";

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
    sessionId: parsed.data.session_id,
  };
}

export interface PullRequestLink {
  number?: number | undefined;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

/** Present when the turn answers a pull request comment. */
export interface CommentFinishDeps {
  repository: string;
  pullRequestUrl: string;
  github: PullRequestWriter;
  push: (message: string) => Promise<number>;
}

export interface FinishDeps {
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
  const text = [result.reply, deps.pullRequestUrl && `Pull request: ${deps.pullRequestUrl}`]
    .filter(Boolean)
    .join("\n\n");
  if (text) return deliver(deps.poster, state, text, result.title);
  if (!state.threadId) throw new Error("the agent can only stay silent in an existing thread");
  return state.threadId;
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
  const pushed = await comment.push(cleanTitle(result.prTitle) || DEFAULT_COMMIT_MESSAGE);
  const body = result.reply ?? (pushed > 0 ? `Pushed ${plural(pushed)}.` : undefined);
  if (body) {
    await comment.github.comment(
      comment.repository,
      state.pullRequest,
      `${REPLY_MARKER}\n${body}`,
      state.replyTo,
    );
    const note = result.reply
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
  return { threadId: state.threadId, pullRequest: state.pullRequest };
}

export async function finish(deps: FinishDeps) {
  const state = await readState(deps.workspace);
  const result = extractResult(await readFile(deps.executionFile, "utf8"));
  let threadId: string;
  let link = deps.pullRequestLink;
  if (deps.comment) {
    const answered = await finishComment(deps, deps.comment, state, result);
    threadId = answered.threadId;
    link = link && { ...link, number: answered.pullRequest };
  } else {
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
