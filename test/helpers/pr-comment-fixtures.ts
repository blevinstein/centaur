import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { threadKey } from "../../src/thread-key.js";
import type { FinishDeps } from "../../src/workflows/finish.js";
import type { PrepareDeps, TurnState } from "../../src/workflows/prepare.js";
import type {
  PullRequestComment,
  PullRequestDetails,
  PullRequestReader,
  PullRequestWriter,
} from "../../src/workflows/pull-request-comments.js";
import { REPLY_MARKER } from "../../src/workflows/resolve.js";
import { writeTurnState } from "../../src/workflows/turn-state.js";
import {
  configText,
  createFakeAws,
  createWorkspace,
  pullRequestLink,
  THREAD,
} from "./workflow-fixtures.js";

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
  association: "COLLABORATOR",
  body,
  at: `2026-11-17T10:00:0${id}Z`,
  ...overrides,
});

export const agentComment = (id: number, overrides: Partial<PullRequestComment> = {}) =>
  prComment(id, `Done.\n${REPLY_MARKER}`, {
    author: "github-actions[bot]",
    isBot: true,
    association: "NONE",
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
    storedPolicy?: string;
    config?: string;
    configFile?: string;
    files?: Record<string, string>;
    bot?: string;
    threadId?: string;
    found?: boolean;
    details?: Partial<PullRequestDetails>;
    mcpPolicy?: PrepareDeps["mcpPolicy"];
  } = { comments: [] },
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "resolve-pull-request") {
      return options.found === false
        ? { found: false }
        : {
            found: true,
            bot: options.bot ?? "sprout",
            threadKey: "k",
            threadId: options.threadId ?? THREAD,
          };
    }
    if (request.operation === "read")
      return {
        messages: options.messages ?? [],
        ...(options.storedPolicy ? { policy: options.storedPolicy } : {}),
      };
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
  const { root, home, stateDir } = await createWorkspace({
    [options.configFile ?? ".centaur.yml"]: options.config ?? configText(),
    ".centaur/persona.md": "Be kind.",
    ...options.files,
  });
  const deps = (): PrepareDeps => ({
    workspace: root,
    stateDir,
    home,
    runId: "42",
    env: {},
    clientPayload: undefined,
    poster: aws.poster,
    fetchToken: async () => "jwt",
    attachments: aws.attachments,
    storeFor: aws.storeFor,
    mcpPolicy: options.mcpPolicy,
    comment: {
      pullRequest: PULL_REQUEST,
      repository: "octo/sprout",
      github,
      fetchToken: async () => "jwt",
      mask,
    },
  });
  return { aws, github, mask, root, home, stateDir, deps };
}

export const NEW_PULL_REQUEST = 20;
export const NEW_PR_URL = "https://github.example/octo/sprout/pull/20";
export const ORIGINAL_SHA = "a".repeat(40);
export const RUN_URL = "https://github.example/octo/sprout/actions/runs/99";
export const PR_URL = "https://github.example/octo/sprout/pull/12";

export async function commentFinishSetup(
  options: {
    state?: Partial<TurnState>;
    pushed?: number;
    fail?: "chat" | "push";
    newPr?: { stacked: boolean } | "no-changes";
  } = {},
) {
  const aws = createFakeAws((request) => {
    if (request.operation === "post" && options.fail === "chat") throw new Error("chat is down");
    return {};
  });
  const { root, home, stateDir } = await createWorkspace({});
  const state: TurnState = {
    mode: "comment",
    bot: "sprout",
    threadId: THREAD,
    pullRequest: PULL_REQUEST,
    policy: "transcript",
    sessionDirectory: join(home, "session"),
    ...options.state,
  };
  await writeTurnState(stateDir, state);
  const executionFile = join(root, "execution.json");
  const writeExecution = (entry: object) =>
    writeFile(executionFile, JSON.stringify([{ type: "system" }, { type: "result", ...entry }]));
  const github: PullRequestWriter = {
    comment: vi.fn(async () => {}),
    head: vi.fn(async () => ({ ref: HEAD_REF, sha: ORIGINAL_SHA })),
    defaultBranch: vi.fn(async () => "main"),
    createPullRequest: vi.fn(async () => ({ number: NEW_PULL_REQUEST, url: NEW_PR_URL })),
  };
  const pushNew = vi.fn(
    async (_options: { branch: string; message: string; originalHeadSha: string }) => {
      if (options.fail === "push") throw new Error("push rejected");
      return options.newPr === "no-changes" ? undefined : (options.newPr ?? { stacked: true });
    },
  );
  const push = vi.fn(async (_message: string) => {
    if (options.fail === "push") throw new Error("push rejected");
    return options.pushed ?? 0;
  });
  const deps = (): FinishDeps => ({
    stateDir,
    executionFile,
    poster: aws.poster,
    storeFor: aws.storeFor,
    pullRequestLink: pullRequestLink(0),
    runUrl: RUN_URL,
    comment: {
      repository: "octo/sprout",
      pullRequestUrl: PR_URL,
      github,
      push,
      ...(options.newPr
        ? { newPullRequest: { runId: "99", attempt: "2", runUrl: RUN_URL, push: pushNew } }
        : {}),
    },
  });
  return { aws, root, home, stateDir, github, push, pushNew, deps, writeExecution };
}

export const restComment = (
  id: number,
  association: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  id,
  body: `comment ${id}`,
  created_at: `2026-11-17T10:00:0${id}Z`,
  user: { login: `user${id}`, type: "User" },
  ...(association === undefined ? {} : { author_association: association }),
  ...extra,
});

export const fakeGitHubFetch = (routes: Record<string, unknown[]>): typeof fetch =>
  vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    return Response.json(path in routes ? routes[path] : []);
  }) as unknown as typeof fetch;
