import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpApprovalKey } from "../../src/config/mcp-fingerprint.js";
import { mcpApprovalParameter } from "../../src/lambda/connection-paths.js";
import { createCliHarness } from "./cli.js";
import { localServerYaml, mcpServersFrom, yamlOf } from "./config-fixtures.js";
import {
  fakePolicyGitHub,
  PERMIT_ANY_PINNED_APPROVED,
  POLICY_REPOSITORY,
} from "./mcp-policy-fixtures.js";

export const SERVER_NAME = "docs-search";

const ALLOWED_TOOL = `mcp__${SERVER_NAME}__*`;

export const UNPINNED_SERVER_YAML = localServerYaml.replace(
  "@example/docs-mcp@1.4.2",
  "@example/docs-mcp",
);

const configWith = (servers: string) =>
  `${yamlOf({ bot: "garden", allowed_tools: undefined })}\nmcp_servers:\n${servers}\nallowed_tools: [Read, "${ALLOWED_TOOL}"]`;

/** The parameter an approval of `SERVER_NAME` as declared in `servers` is stored under. */
export const approvalParameterFor = (servers: string, bot = "garden") => {
  const [server, fingerprint] = mcpApprovalKey(
    SERVER_NAME,
    mcpServersFrom(servers)[SERVER_NAME] as never,
    ["Read", ALLOWED_TOOL],
  ).split(":");
  return mcpApprovalParameter(bot, server as string, fingerprint as string);
};

/** A harness whose bot `garden` is bound to a repository with the given default-branch files. */
export async function createApproveHarness({
  servers = localServerYaml,
  policy = PERMIT_ANY_PINNED_APPROVED,
}: {
  servers?: string;
  policy?: string;
} = {}) {
  const github = fakePolicyGitHub({ config: configWith(servers), policy });
  const cli = createCliHarness(
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    async () => github.github,
  );
  await cli.connect("garden", "telegram");
  await cli.bind("garden", POLICY_REPOSITORY);
  return { ...cli, ...github, parameter: approvalParameterFor(servers) };
}

export async function globalPolicyFile(text: string) {
  const path = join(await mkdtemp(join(tmpdir(), "centaur-global-policy-")), "mcp-policy.cedar");
  await writeFile(path, text);
  return path;
}
