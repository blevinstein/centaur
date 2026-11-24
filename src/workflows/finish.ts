import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MCP_APPROVAL_SERVERS_MAX } from "../lambda/mcp-approvals.js";
import { threadKey } from "../thread-key.js";
import type { PosterClient, ThreadStore } from "./aws.js";
import { cleanBody, cleanTitle } from "./clean-text.js";
import { approvalsRequest } from "./mcp-approval.js";
import type { StartTarget, TurnState } from "./prepare.js";
import { pullRequestDetails } from "./pull-request.js";
import type { PullRequestWriter } from "./pull-request-comments.js";
import { clearReactions } from "./reactions.js";
import { BRANCH_PREFIX, REPLY_MARKER } from "./resolve.js";
import { readTurnState } from "./turn-state.js";

const DEFAULT_COMMIT_MESSAGE = "Address review comments";
const DEFAULT_NEW_TITLE = "Centaur agent changes";

const NO_REPLY = "the agent produced no structured reply";

export const waitingReply = (servers: string[]) =>
  `Waiting for the admin to approve ${servers.join(", ")}, then I'll carry on.`;

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
      suspend_for: z.array(z.string()).max(MCP_APPROVAL_SERVERS_MAX).optional(),
    })
    .refine((output) => {
      const replied = output.reply !== undefined;
      const ignored = output.ignore === true;
      return replied !== ignored || (!replied && !ignored && !!output.suspend_for?.length);
    }),
});

export function extractResult(executionFileText: string) {
  const entries = JSON.parse(executionFileText) as { type?: string }[];
  const last = entries.findLast((entry) => entry.type === "result");
  const parsed = resultMessage.safeParse(last);
  if (!parsed.success) throw new Error(NO_REPLY);
  return {
    reply: parsed.data.structured_output.reply,
    ignore: parsed.data.structured_output.ignore === true,
    title: parsed.data.structured_output.new_thread_title,
    prTitle: parsed.data.structured_output.pr_title,
    prBody: parsed.data.structured_output.pr_body,
    prAction: parsed.data.structured_output.pr_action,
    existingPr: parsed.data.structured_output.existing_pr_number,
    suspendFor: parsed.data.structured_output.suspend_for,
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
  stateDir: string;
  executionFile: string;
  pullRequestUrl?: string | undefined;
  pullRequestLink?: PullRequestLink | undefined;
  /** OIDC token for the poster calls that act for the repository; without it a turn cannot suspend. */
  fetchToken?: (() => Promise<string>) | undefined;
  poster: PosterClient;
  storeFor: (bot: string, threadId: string) => ThreadStore;
}

interface Delivery {
  /** Threads the reply reached, in target order; the first is the primary thread. */
  threadIds: string[];
  /** Targets that did not receive the reply, described without any message text. */
  failed: string[];
}

const describeTarget = (state: TurnState, target: StartTarget) =>
  "destination" in target
    ? `${state.bot}/${target.platform}/${target.destination}`
    : `${state.bot}/new thread`;

/** Starts a thread per target, attempting every one even when an earlier one fails. */
async function deliver(
  poster: PosterClient,
  state: TurnState,
  text: string,
  title: string | undefined,
): Promise<Delivery> {
  if (state.mode === "reply" && state.threadId) {
    await poster.call({ operation: "post", bot: state.bot, threadId: state.threadId, text });
    return { threadIds: [state.threadId], failed: [] };
  }
  if (!state.start?.length) throw new Error("the turn names no chat to start a thread in");
  const delivery: Delivery = { threadIds: [], failed: [] };
  for (const target of state.start) {
    try {
      const started = await poster.call<{ threadId: string }>({
        operation: "start-thread",
        bot: state.bot,
        text,
        ...target,
        ...("destination" in target ? { context: state.policy } : {}),
        ...(title ? { title } : {}),
      });
      delivery.threadIds.push(started.threadId);
    } catch (error) {
      if (state.start.length === 1) throw error;
      const described = describeTarget(state, target);
      console.warn(
        `::warning::could not post to ${described} (${(error as Error).constructor.name})`,
      );
      delivery.failed.push(described);
    }
  }
  return delivery;
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
  return { threadIds: [state.threadId], failed: [] };
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

/** The servers named in `suspend_for` that were pending when the turn started; the rest is ignored. */
const suspendedServers = (state: TurnState, result: ReturnType<typeof extractResult>) =>
  state.suspend?.servers.filter(({ name }) => result.suspendFor?.includes(name)) ?? [];

/**
 * Gives a suspend without a reply the shared waiting line. An output that has neither a reply, an
 * ignore nor a valid suspend names nothing to post and fails like an unparsable one.
 */
function withSuspendReply(state: TurnState, result: ReturnType<typeof extractResult>) {
  if (result.reply !== undefined || result.ignore) return result;
  const servers = suspendedServers(state, result);
  if (servers.length === 0) throw new Error(NO_REPLY);
  return { ...result, reply: waitingReply(servers.map(({ name }) => name)) };
}

/**
 * Marks the requests of the servers the agent suspended for. Returns whether the thread is
 * suspended. The 👀 is cleared first, because the call leaves the waiting reaction on the message
 * and a platform that keeps one reaction per message would drop it. A failed call is logged without
 * text or IDs, and the turn ends as an ordinary one.
 */
async function suspendForApprovals(
  deps: FinishDeps,
  state: TurnState,
  result: ReturnType<typeof extractResult>,
  clearReactionsOnce: () => Promise<void>,
) {
  const { suspend } = state;
  const servers = suspendedServers(state, result);
  if (!suspend || !deps.fetchToken || servers.length === 0) return false;
  try {
    await clearReactionsOnce();
    await deps.poster.mcpApprovals(
      approvalsRequest(
        { token: await deps.fetchToken(), bot: state.bot, servers, suspend: true },
        suspend.thread,
      ),
    );
    return true;
  } catch (error) {
    console.warn(
      `::warning::could not suspend the thread for MCP server approval (${(error as Error).name})`,
    );
    return false;
  }
}

export async function finish(deps: FinishDeps) {
  const state = await readTurnState(deps.stateDir);
  const result = withSuspendReply(
    state,
    ignoreMisplacedTargets(state, extractResult(await readFile(deps.executionFile, "utf8"))),
  );
  let delivery: Delivery;
  let link = deps.pullRequestLink;
  if (deps.comment) {
    const answered = await finishComment(deps, deps.comment, state, result);
    delivery = { threadIds: [answered.threadId], failed: [] };
    link = link && { ...link, number: answered.pullRequest };
    if (link && answered.opened !== undefined) {
      await linkPullRequest(
        deps.poster,
        { ...link, number: answered.opened },
        state.bot,
        answered.threadId,
      );
    }
  } else {
    if (deps.updatedPullRequest) {
      await commentOnUpdatedPullRequest(deps.updatedPullRequest, state, result);
      link = link && { ...link, number: undefined };
    }
    delivery = await deliverReply(deps, state, result);
  }

  let cleared = false;
  const clearReactionsOnce = async () => {
    if (cleared) return;
    cleared = true;
    await clearReactions(deps.poster, state.source);
  };
  const [threadId] = delivery.threadIds;
  let suspended = false;
  if (threadId) {
    await linkPullRequest(deps.poster, link, state.bot, threadId);
    const store = deps.storeFor(state.bot, threadId);
    suspended = await suspendForApprovals(deps, state, result, clearReactionsOnce);
    if (!suspended && state.marker && (state.markerThreadId ?? threadId) === threadId) {
      await store.writeMarker(state.marker);
    }
    if (state.policy === "resume" && result.sessionId) {
      await store.saveSession(state.sessionDirectory, result.sessionId);
    }
  }
  if (delivery.failed.length > 0) {
    throw new Error(
      `the reply reached ${delivery.threadIds.length} of ${delivery.threadIds.length + delivery.failed.length} targets; failed: ${delivery.failed.join(", ")}`,
    );
  }
  if (!suspended) await clearReactionsOnce();
}

export async function notifyFailure(
  deps: Pick<FinishDeps, "stateDir" | "poster"> & {
    runUrl: string;
    comment?: Pick<CommentFinishDeps, "repository" | "github"> | undefined;
  },
) {
  const state = await readTurnState(deps.stateDir).catch((error: NodeJS.ErrnoException) => {
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
