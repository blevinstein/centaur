import { z } from "zod";
import { createGitHubRequester, type GitHubRequester, REPLY_MARKER } from "./resolve.js";

const PAGE_SIZE = 100;
export const MAX_DIFF_CHARS = 100_000;

const user = z.object({ login: z.string(), type: z.string() });
const timestamp = z.string().min(1);

const pullRequestResponse = z.object({
  title: z.string(),
  body: z.string().nullable(),
  created_at: timestamp,
  head: z.object({ ref: z.string() }),
});
const issueCommentResponse = z.object({
  id: z.number(),
  body: z.string().nullish(),
  created_at: timestamp,
  user: user.nullable(),
});
const reviewResponse = z.object({
  id: z.number(),
  body: z.string().nullish(),
  state: z.string(),
  submitted_at: timestamp.nullish(),
  user: user.nullable(),
});
const reviewCommentResponse = z.object({
  id: z.number(),
  body: z.string(),
  created_at: timestamp,
  user: user.nullable(),
  path: z.string(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  diff_hunk: z.string(),
  in_reply_to_id: z.number().nullish(),
  pull_request_review_id: z.number().nullish(),
});

export interface PullRequestDetails {
  title: string;
  body: string;
  createdAt: string;
  headRef: string;
}

export interface PullRequestComment {
  kind: "conversation" | "review" | "inline";
  id: number;
  author: string;
  isBot: boolean;
  body: string;
  at: string;
  reviewState?: string;
  path?: string;
  line?: number;
  diffHunk?: string;
  threadRoot?: number;
}

export interface PullRequestReader {
  details(repository: string, number: number): Promise<PullRequestDetails>;
  comments(repository: string, number: number): Promise<PullRequestComment[]>;
  diff(repository: string, number: number): Promise<string>;
}

export interface PullRequestWriter {
  /** Posts a conversation comment, or a reply in the inline thread rooted at `replyTo`. */
  comment(repository: string, number: number, body: string, replyTo?: number): Promise<void>;
}

/** Posts to a pull request with the job's token; errors name only the HTTP status. */
export function createPullRequestWriter(
  token: string,
  apiUrl?: string,
  fetchImpl?: typeof fetch,
): PullRequestWriter {
  const requester = createGitHubRequester(token, apiUrl, fetchImpl);
  return {
    comment: (repository, number, body, replyTo) =>
      requester.post(
        replyTo === undefined
          ? `/repos/${repository}/issues/${number}/comments`
          : `/repos/${repository}/pulls/${number}/comments/${replyTo}/replies`,
        { body },
      ),
  };
}

async function paginate<T>(
  requester: GitHubRequester,
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await requester.json(
      `${path}?per_page=${PAGE_SIZE}&page=${page}`,
      z.array(schema),
    );
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
}

/** Reads a pull request's discussion with the job's token; errors name only the HTTP status. */
export function createPullRequestReader(
  token: string,
  apiUrl?: string,
  fetchImpl?: typeof fetch,
): PullRequestReader {
  const requester = createGitHubRequester(token, apiUrl, fetchImpl);
  const author = (u: z.infer<typeof user> | null) => ({
    author: u?.login ?? "unknown",
    isBot: u === null || u.type === "Bot",
  });
  return {
    async details(repository, number) {
      const data = await requester.json(
        `/repos/${repository}/pulls/${number}`,
        pullRequestResponse,
      );
      return {
        title: data.title,
        body: data.body ?? "",
        createdAt: data.created_at,
        headRef: data.head.ref,
      };
    },
    async comments(repository, number) {
      const [conversation, reviews, inline] = await Promise.all([
        paginate(requester, `/repos/${repository}/issues/${number}/comments`, issueCommentResponse),
        paginate(requester, `/repos/${repository}/pulls/${number}/reviews`, reviewResponse),
        paginate(requester, `/repos/${repository}/pulls/${number}/comments`, reviewCommentResponse),
      ]);
      return [
        ...conversation.map(
          (c): PullRequestComment => ({
            kind: "conversation",
            id: c.id,
            ...author(c.user),
            body: c.body ?? "",
            at: c.created_at,
          }),
        ),
        ...reviews.flatMap((r): PullRequestComment[] =>
          r.submitted_at
            ? [
                {
                  kind: "review",
                  id: r.id,
                  ...author(r.user),
                  body: r.body ?? "",
                  at: r.submitted_at,
                  reviewState: r.state,
                },
              ]
            : [],
        ),
        ...inline.map(
          (c): PullRequestComment => ({
            kind: "inline",
            id: c.id,
            ...author(c.user),
            body: c.body,
            at: c.created_at,
            path: c.path,
            ...((c.line ?? c.original_line) ? { line: (c.line ?? c.original_line) as number } : {}),
            diffHunk: c.diff_hunk,
            threadRoot: c.in_reply_to_id ?? c.id,
          }),
        ),
      ];
    },
    diff: (repository, number) =>
      requester.text(`/repos/${repository}/pulls/${number}`, "application/vnd.github.diff"),
  };
}

/** A review with no text and only inline comments adds nothing beyond those comments. */
const isEmptyReview = (c: PullRequestComment) =>
  c.kind === "review" && c.body.trim() === "" && c.reviewState === "COMMENTED";

/**
 * Human comments newer than the agent's latest marked comment, or newer than the pull request when
 * the agent has not replied yet. Marked comments are never input, whoever posted them.
 */
export function pendingComments(comments: PullRequestComment[], createdAt: string) {
  const marked = (c: PullRequestComment) => c.body.includes(REPLY_MARKER);
  const cutoff = [createdAt, ...comments.filter(marked).map((c) => c.at)].sort().at(-1) as string;
  return comments
    .filter((c) => !c.isBot && !marked(c) && c.at > cutoff && !isEmptyReview(c))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The inline thread all of the comments belong to, if they are in exactly one. */
export function singleInlineThread(pending: PullRequestComment[]) {
  const roots = new Set(pending.map((c) => (c.kind === "inline" ? c.threadRoot : undefined)));
  const [root] = roots;
  return roots.size === 1 && root !== undefined ? root : undefined;
}

/** Wraps untrusted text in a code fence longer than any backtick run inside it. */
export function fence(text: string, info = "") {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}

const location = (c: PullRequestComment) => `${c.path}${c.line ? `:${c.line}` : ""}`;

function renderComment(c: PullRequestComment, isNew: boolean) {
  const label = c.kind === "review" ? `review (${c.reviewState?.toLowerCase()})` : "comment";
  const marked = c.body.includes(REPLY_MARKER);
  const who = marked ? "assistant" : c.author;
  return `[${c.at}] ${who}, ${label}${isNew ? " (new)" : ""}:\n${fence(c.body.replaceAll(REPLY_MARKER, "").trim())}`;
}

/**
 * Renders the pending comments for the prompt: conversation comments and reviews in order, then
 * each inline thread with its file, line, diff hunk and the earlier comments in the thread. Every
 * body is fenced as quoted data.
 */
export function renderComments(all: PullRequestComment[], pending: PullRequestComment[]) {
  const pendingIds = new Set(pending.map((c) => `${c.kind}:${c.id}`));
  const isNew = (c: PullRequestComment) => pendingIds.has(`${c.kind}:${c.id}`);
  const general = pending.filter((c) => c.kind !== "inline");
  const roots = [
    ...new Set(pending.flatMap((c) => (c.kind === "inline" ? [c.threadRoot as number] : []))),
  ];
  const threads = roots.map((root) => {
    const members = all
      .filter((c) => c.kind === "inline" && c.threadRoot === root)
      .sort((a, b) => a.at.localeCompare(b.at));
    const first = members[0] as PullRequestComment;
    return [
      `## Inline thread on ${location(first)}`,
      fence(first.diffHunk ?? "", "diff"),
      ...members.map((c) => renderComment(c, isNew(c))),
    ].join("\n\n");
  });
  return [
    ...(general.length > 0
      ? ["## Conversation and reviews", ...general.map((c) => renderComment(c, true))]
      : []),
    ...threads,
  ].join("\n\n");
}

export const truncateDiff = (diff: string) =>
  diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]`
    : diff;
