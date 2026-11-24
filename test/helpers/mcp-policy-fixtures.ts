import { vi } from "vitest";
import type { McpPolicyResult } from "../../src/config/mcp-policy.js";
import type { PosterClient } from "../../src/workflows/aws.js";
import { GitHubRequestError, type GitHubRequester } from "../../src/workflows/resolve.js";
import { localServerYaml, mcpServersFrom, remoteServerYaml } from "./config-fixtures.js";

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

export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export const GIT_REPO_URL = "git+https://github.com/example-org/example-mcp-server";

export const PERMIT_UVX = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.command == "uvx" };`;

export const PERMIT_UVX_GIT_SOURCE = `permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "uvx" && resource.pinned &&
    resource.args == ["--from", "${GIT_REPO_URL}@${COMMIT_SHA}", "example-entrypoint"]
  };`;

export const PERMIT_ANY_PINNED_APPROVED = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.pinned && context.approved };`;

export const PERMIT_ANY_PINNED = `permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.pinned };`;

export const uvxArgsServers = (args: string[]) =>
  mcpServersFrom(`  git-mcp:\n    command: uvx\n    args: ${JSON.stringify(args)}\n`);

export const uvxGitServers = (source: string) =>
  uvxArgsServers(["--from", source, "example-entrypoint"]);

const PINNED_SOURCE = `${GIT_REPO_URL}@${COMMIT_SHA}`;

export const UVX_GIT_BYPASSES: [string, string[]][] = [
  [
    "a different pinned first package",
    ["other==1.0.0", "--from", PINNED_SOURCE, "example-entrypoint"],
  ],
  ["an extra trailing argument", ["--from", PINNED_SOURCE, "example-entrypoint", "--extra"]],
  ["the source listed after another entrypoint", ["--from", PINNED_SOURCE, "other-entrypoint"]],
];

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
    listThreads: vi.fn(),
    readChannel: vi.fn(),
    mcpApprovals: vi.fn(),
  };
  return {
    github,
    paths,
    posterRequests,
    deps: { repository: POLICY_REPOSITORY, github, poster },
  };
}

export const PERMIT_WHEN_APPROVED = `permit(principal, action == Action::"UseServer", resource)
  when { context.approved };`;

export const PERMIT_WHEN_NOT_APPROVED = `permit(principal, action == Action::"UseServer", resource)
  when { !context.approved };`;

export const FORBID_ALL = `forbid(principal, action, resource);`;

export const FORBID_WHEN_NOT_APPROVED = `forbid(principal, action, resource)
  when { !context.approved };`;

export const ALLOWED = "allow";
export const APPROVAL_REQUIRED = "approval-required";

export const outcomeOf = ({ issues, approvals }: McpPolicyResult) =>
  issues[0]?.message ?? (approvals.length > 0 ? APPROVAL_REQUIRED : ALLOWED);

export const REMOTE_SERVER_VARIANTS = {
  base: remoteServerYaml,
  url: remoteServerYaml.replace("mcp.linear.app", "mcp.example.org"),
  plainHeader: remoteServerYaml.replace("X-Org: acme", "X-Org: other"),
  secretName: remoteServerYaml.replace("LINEAR_API_KEY", "OTHER_API_KEY"),
  headerOrder: `  linear:
    headers:
      X-Org: acme
      Authorization: { secret: LINEAR_API_KEY, prefix: "Bearer " }
    url: https://mcp.linear.app/mcp
`,
};

export const LOCAL_SERVER_VARIANTS = {
  base: localServerYaml,
  command: localServerYaml.replace("npx", "pnpx"),
  args: localServerYaml.replace("1.4.2", "1.4.3"),
  plainEnv: localServerYaml.replace("docs.example.com", "docs.example.org"),
  secretName: localServerYaml.replace("DOCS_API_KEY", "OTHER_API_KEY"),
  envOrder: `  docs-search:
    env:
      API_KEY: { secret: DOCS_API_KEY }
      INDEX_URL: https://docs.example.com/index
    args: ["-y", "@example/docs-mcp@1.4.2"]
    command: npx
`,
};
