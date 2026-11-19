import { vi } from "vitest";
import { threadKey } from "../../src/thread-key.js";
import type { PrepareDeps } from "../../src/workflows/prepare.js";
import type {
  PullRequestComment,
  PullRequestDetails,
  PullRequestReader,
} from "../../src/workflows/pull-request-comments.js";
import { REPLY_MARKER } from "../../src/workflows/resolve.js";
import { configText, createFakeAws, createWorkspace, THREAD } from "./workflow-fixtures.js";

export const PULL_REQUEST = 12;
export const HEAD_REF = `centaur/sprout-${threadKey("sprout", THREAD)}`;
export const PR_CREATED = "2026-11-17T09:00:00Z";
export const DIFF = "diff --git a/plan.md b/plan.md\n+tomatoes";

export const prComment = (
  id: number,
  body: string,
  overrides: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  kind: "conversation",
  id,
  author: "sam",
  isBot: false,
  body,
  at: `2026-11-17T10:00:0${id}Z`,
  ...overrides,
});

export const agentComment = (id: number, overrides: Partial<PullRequestComment> = {}) =>
  prComment(id, `Done.\n${REPLY_MARKER}`, {
    author: "github-actions[bot]",
    isBot: true,
    ...overrides,
  });

export const inlineComment = (
  id: number,
  body: string,
  overrides: Partial<PullRequestComment> = {},
) =>
  prComment(id, body, {
    kind: "inline",
    path: "plan.md",
    line: 3,
    diffHunk: "@@ -1 +1 @@\n+tomatoes",
    threadRoot: id,
    ...overrides,
  });

export async function commentSetup(
  options: {
    comments: PullRequestComment[];
    messages?: ReturnType<typeof import("./workflow-fixtures.js").message>[];
    config?: string;
    files?: Record<string, string>;
    bot?: string;
    found?: boolean;
    details?: Partial<PullRequestDetails>;
  } = { comments: [] },
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "resolve-pull-request") {
      return options.found === false
        ? { found: false }
        : { found: true, bot: options.bot ?? "sprout", threadKey: "k", threadId: THREAD };
    }
    if (request.operation === "read") return { messages: options.messages ?? [] };
    return {};
  });
  const github: PullRequestReader = {
    details: vi.fn(async () => ({
      title: "Weekly tasks",
      body: "Adds tasks.",
      createdAt: PR_CREATED,
      headRef: HEAD_REF,
      ...options.details,
    })),
    comments: vi.fn(async () => options.comments),
    diff: vi.fn(async () => DIFF),
  };
  const mask = vi.fn();
  const { root, home } = await createWorkspace({
    ".centaur.yml": options.config ?? configText(),
    ".centaur/persona.md": "Be kind.",
    ...options.files,
  });
  const deps = (): PrepareDeps => ({
    workspace: root,
    home,
    runId: "42",
    env: {},
    clientPayload: undefined,
    poster: aws.poster,
    attachments: aws.attachments,
    storeFor: aws.storeFor,
    comment: {
      pullRequest: PULL_REQUEST,
      repository: "octo/sprout",
      github,
      fetchToken: async () => "jwt",
      mask,
    },
  });
  return { aws, github, mask, root, home, deps };
}
