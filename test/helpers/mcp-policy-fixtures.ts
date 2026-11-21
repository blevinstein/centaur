import { vi } from "vitest";
import type { PosterClient } from "../../src/workflows/aws.js";
import { GitHubRequestError, type GitHubRequester } from "../../src/workflows/resolve.js";
import { localServerYaml, mcpServersFrom } from "./config-fixtures.js";

export const GITHUB_HOST = "api.githubcopilot.com";

export const PERMIT_GITHUB = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "remote" && resource.host == "${GITHUB_HOST}" };`;

export const PERMIT_PINNED_NPX = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.command == "npx" && resource.pinned };`;

export const PERMIT_ANY_REMOTE = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "remote" };`;

export const permitForBot = (bot: string) =>
  `permit(principal == Bot::"${bot}", action == Action::"UseServer", resource);`;

export const FORBID_UNTRUSTED = `forbid(principal, action, resource)
  when { resource.host like "*.untrusted.example" };`;

export const FORBID_UNLESS_GITHUB = `forbid(principal, action, resource)
  unless { resource.host == "${GITHUB_HOST}" };`;

const serverOf = (servers: ReturnType<typeof mcpServersFrom>, name: string) => {
  const server = servers[name];
  if (!server) throw new Error(`missing fixture server ${name}`);
  return server;
};

export const githubServers = mcpServersFrom(`  ghmcp:\n    url: https://${GITHUB_HOST}/mcp/\n`);

export const githubServer = serverOf(githubServers, "ghmcp");

export const docsSearchServer = serverOf(mcpServersFrom(localServerYaml), "docs-search");

export const untrustedServers = mcpServersFrom(
  "  evil:\n    url: https://mcp.untrusted.example/mcp\n",
);

export const npxServers = (pkg: string) =>
  mcpServersFrom(`  docs:\n    command: npx\n    args: ["-y", "${pkg}"]\n`);

export const GITHUB_SERVER_CONFIG = {
  mcp_servers: `{ghmcp: {url: "https://${GITHUB_HOST}/mcp/"}}`,
  allowed_tools: '"Read, mcp__ghmcp__*"',
};

export const POLICY_REPOSITORY = "octo/sprout";

export const policyPath = (ref: string) =>
  `/repos/${POLICY_REPOSITORY}/contents/.centaur/mcp-policy.cedar?ref=${ref}`;

export const WORKSPACE_PERMIT_FILES = {
  ".centaur/mcp-policy.cedar": PERMIT_ANY_REMOTE,
};

export function fakePolicyGitHub(
  options: {
    policy?: string;
    defaultBranch?: string;
    repositoryStatus?: number;
    contentsStatus?: number;
    globalPolicy?: string;
    posterFails?: boolean;
  } = {},
) {
  const paths: string[] = [];
  const unused = vi.fn(async () => {
    throw new Error("unexpected GitHub call");
  });
  const github: GitHubRequester = {
    json: vi.fn(async (path, schema) => {
      paths.push(path);
      if (options.repositoryStatus) throw new GitHubRequestError(options.repositoryStatus);
      return schema.parse({ default_branch: options.defaultBranch ?? "main" });
    }),
    text: vi.fn(async (path) => {
      paths.push(path);
      if (options.contentsStatus) throw new GitHubRequestError(options.contentsStatus);
      if (options.policy === undefined) throw new GitHubRequestError(404);
      return options.policy;
    }),
    post: unused,
    postJson: unused,
  };
  const posterRequests: unknown[] = [];
  const poster: PosterClient = {
    call: vi.fn(async (request) => {
      posterRequests.push(request);
      if (options.posterFails) throw new Error("poster get-mcp-policy failed (Error)");
      return { policy: options.globalPolicy ?? null } as never;
    }),
  };
  return {
    github,
    paths,
    posterRequests,
    deps: { repository: POLICY_REPOSITORY, github, poster },
  };
}

export const FORBID_DELETE_UNLESS_ALLOWED_ID = `forbid(principal, action == Action::"CallTool", resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless { context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id) };`;

export const FORBID_DELETE_UNGUARDED = `forbid(principal, action == Action::"CallTool", resource)
  when { resource.name == "delete_issue" && !(["ENG-1"].contains(context.args.id)) };`;
