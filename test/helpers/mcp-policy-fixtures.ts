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

export const forbidForBot = (bot: string) =>
  `forbid(principal == Bot::"${bot}", action, resource);`;

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
