import { describe, expect, it } from "vitest";
import { parseConfigOrThrow } from "../src/workflows/config-file.js";
import { checkRepositoryMcpPolicy, MCP_POLICY_FILE } from "../src/workflows/mcp-policy-check.js";
import { registerRepo } from "../src/workflows/register.js";
import {
  fakePolicyGitHub,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
  policyPath,
  WORKSPACE_PERMIT_FILES,
} from "./helpers/mcp-policy-fixtures.js";
import {
  configText,
  createFakeAws,
  createWorkspace,
  mcpConfigText,
} from "./helpers/workflow-fixtures.js";

const mcpConfig = () => parseConfigOrThrow(mcpConfigText());
const messages = async (options?: Parameters<typeof fakePolicyGitHub>[0]) =>
  (await checkRepositoryMcpPolicy(mcpConfig(), fakePolicyGitHub(options).deps)).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );

describe("checkRepositoryMcpPolicy", () => {
  it("reads the file at the repository's default branch", async () => {
    const { deps, paths } = fakePolicyGitHub({ policy: PERMIT_ANY_REMOTE, defaultBranch: "trunk" });

    expect(await checkRepositoryMcpPolicy(mcpConfig(), deps)).toEqual([]);
    expect(paths).toEqual(["/repos/octo/sprout", policyPath("trunk")]);
  });

  it("percent-encodes the default branch name", async () => {
    const { deps, paths } = fakePolicyGitHub({ policy: PERMIT_ANY_REMOTE, defaultBranch: "a/b" });

    await checkRepositoryMcpPolicy(mcpConfig(), deps);

    expect(paths[1]).toBe(policyPath("a%2Fb"));
  });

  it("denies every server when the default branch has no policy file", async () => {
    expect(await messages()).toEqual([
      `mcp_servers.linear: no ${MCP_POLICY_FILE} on the default branch`,
    ]);
  });

  it.each([500, 503, 403])("fails closed on a %i fetching the file", async (contentsStatus) => {
    expect(await messages({ contentsStatus })).toEqual([
      `mcp_servers.linear: cannot read the operator policy: GitHub request failed (${contentsStatus})`,
    ]);
  });

  it("fails closed when the repository lookup fails", async () => {
    expect(await messages({ repositoryStatus: 404 })).toEqual([
      "mcp_servers.linear: cannot read the operator policy: GitHub request failed (404)",
    ]);
  });

  it("denies every server when the policy is invalid", async () => {
    expect((await messages({ policy: "permit(" }))[0]).toMatch(
      /^mcp_servers\.linear: operator policy is invalid/,
    );
  });

  it("denies a server the policy does not permit", async () => {
    expect(await messages({ policy: PERMIT_GITHUB })).toEqual([
      "mcp_servers.linear: not permitted by any policy",
    ]);
  });

  it("denies without GitHub access", async () => {
    expect(await checkRepositoryMcpPolicy(mcpConfig(), undefined)).toHaveLength(1);
  });

  it("never fetches for a config without servers", async () => {
    const { deps, paths } = fakePolicyGitHub();

    expect(await checkRepositoryMcpPolicy(parseConfigOrThrow(configText()), deps)).toEqual([]);
    expect(paths).toEqual([]);
  });
});

describe("registerRepo with servers", () => {
  const setup = async (policy: ReturnType<typeof fakePolicyGitHub>["deps"]) => {
    const aws = createFakeAws(() => ({ bot: "sprout", repo: "octo/sprout" }));
    const { root } = await createWorkspace({
      ".centaur.yml": mcpConfigText(),
      ...WORKSPACE_PERMIT_FILES,
    });
    const run = () =>
      registerRepo({
        workspace: root,
        mcpPolicy: policy,
        poster: aws.poster,
        fetchToken: async () => "jwt",
        mask: () => {},
      });
    return { aws, run };
  };

  it("blocks before the poster call and before requesting a token", async () => {
    const { aws, run } = await setup(fakePolicyGitHub().deps);

    await expect(run()).rejects.toThrow(/mcp_servers\.linear: no \.centaur\/mcp-policy\.cedar/);
    expect(aws.requests).toEqual([]);
  });

  it("registers when the default branch policy permits the servers", async () => {
    const { aws, run } = await setup(fakePolicyGitHub({ policy: PERMIT_ANY_REMOTE }).deps);

    await run();

    expect(aws.requests.map((request) => request.operation)).toEqual(["register"]);
  });
});
