import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mcpApprovalKey } from "../src/config/mcp-fingerprint.js";
import {
  checkMcpPolicy,
  describeServer,
  evaluateMcpPolicy,
  isPinned,
  type PolicyLayers,
  validateMcpPolicy,
} from "../src/config/mcp-policy.js";
import {
  ALLOWED,
  APPROVAL_REQUIRED,
  COMMIT_SHA,
  docsSearchServer,
  FORBID_ALL,
  FORBID_UNLESS_GITHUB,
  FORBID_UNTRUSTED,
  FORBID_WHEN_NOT_APPROVED,
  GIT_REPO_URL,
  githubServer,
  githubServers,
  npxServers,
  outcomeOf,
  PERMIT_ANY_PINNED,
  PERMIT_ANY_PINNED_APPROVED,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
  PERMIT_PINNED_NPX,
  PERMIT_UVX,
  PERMIT_UVX_GIT_SOURCE,
  PERMIT_WHEN_APPROVED,
  PERMIT_WHEN_NOT_APPROVED,
  permitForBot,
  untrustedServers,
  uvxGitServers,
} from "./helpers/mcp-policy-fixtures.js";
import { loadSelfConfig } from "./helpers/self-config.js";

describe("isPinned", () => {
  it.each<[string, string[], boolean]>([
    ["a scoped package at an exact version", ["-y", "@example/docs-mcp@1.4.2"], true],
    ["an unscoped package at an exact version", ["pkg@1.4.2"], true],
    ["a prerelease version", ["pkg@1.4.2-beta.1"], true],
    ["a pip-style exact version", ["pkg==1.4.2"], true],
    ["the latest tag", ["-y", "pkg@latest"], false],
    ["a version range", ["pkg@^1.4.2"], false],
    ["a partial version", ["pkg@1.4"], false],
    ["a bare package", ["pkg"], false],
    ["only flags", ["-y", "--quiet"], false],
    ["no arguments", [], false],
    ["a pinned argument after the package", ["pkg", "other@1.4.2"], false],
  ])("%s", (_name, args, expected) => {
    expect(isPinned(args)).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    ["a git URL at a full commit SHA", `${GIT_REPO_URL}@${COMMIT_SHA}`, true],
    ["an egg fragment", `${GIT_REPO_URL}@${COMMIT_SHA}#egg=name`, true],
    ["a subdirectory fragment", `${GIT_REPO_URL}@${COMMIT_SHA}#subdirectory=x`, true],
    ["an upper-case SHA", `${GIT_REPO_URL}@${COMMIT_SHA.toUpperCase()}`, true],
    ["an npm github shorthand", `github:example-org/example-mcp-server#${COMMIT_SHA}`, true],
    ["an npm git URL committish", `git+https://example.org/path/repo#${COMMIT_SHA}`, true],
    ["a host with a port", `git+https://example.org:8443/o/r@${COMMIT_SHA}`, true],
    ["a 39-digit SHA", `${GIT_REPO_URL}@${COMMIT_SHA.slice(1)}`, false],
    ["a 41-digit SHA", `${GIT_REPO_URL}@${COMMIT_SHA}0`, false],
    ["a short SHA", `${GIT_REPO_URL}@${COMMIT_SHA.slice(0, 7)}`, false],
    ["a branch", `${GIT_REPO_URL}@main`, false],
    ["a tag", `${GIT_REPO_URL}@v1.2.3`, false],
    ["latest", `${GIT_REPO_URL}@latest`, false],
    ["an npm branch", "github:example-org/example-mcp-server#main", false],
    ["no ref", GIT_REPO_URL, false],
    ["ssh", `git+ssh://git@github.com/o/r@${COMMIT_SHA}`, false],
    ["plain http", `git+http://github.com/o/r@${COMMIT_SHA}`, false],
    ["user and token credentials", `git+https://user:token@github.com/o/r@${COMMIT_SHA}`, false],
    ["a token credential", `git+https://token@github.com/o/r@${COMMIT_SHA}`, false],
    ["a parent revision", `${GIT_REPO_URL}@${COMMIT_SHA}~1`, false],
    ["a caret revision", `${GIT_REPO_URL}@${COMMIT_SHA}^`, false],
    ["a path after the ref", `${GIT_REPO_URL}@${COMMIT_SHA}:path`, false],
    ["an unknown fragment", `${GIT_REPO_URL}@${COMMIT_SHA}#sha=abc`, false],
    ["path traversal", `git+https://github.com/../o/r@${COMMIT_SHA}`, false],
  ])("git source: %s", (_name, source, expected) => {
    expect(isPinned(["--from", source, "example-entrypoint"])).toBe(expected);
  });
});

describe("describeServer", () => {
  it("describes a remote server by host and url", () => {
    expect(describeServer(githubServer)).toEqual({
      transport: "remote",
      host: "api.githubcopilot.com",
      url: "https://api.githubcopilot.com/mcp/",
      command: "",
      args: [],
      pinned: false,
    });
  });

  it("describes a stdio server by command, args and pinning", () => {
    expect(describeServer(docsSearchServer)).toEqual({
      transport: "stdio",
      host: "",
      url: "",
      command: "npx",
      args: ["-y", "@example/docs-mcp@1.4.2"],
      pinned: true,
    });
  });
});

describe("checkMcpPolicy", () => {
  const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path);

  it.each<[string, Parameters<typeof checkMcpPolicy>[1], string | undefined, boolean]>([
    ["no policy denies a remote server", githubServers, undefined, false],
    ["an empty policy denies a remote server", githubServers, "", false],
    ["an exact host permit allows", githubServers, PERMIT_GITHUB, true],
    ["an exact host permit does not allow another host", untrustedServers, PERMIT_GITHUB, false],
    [
      "a pinned npx permit allows a pinned package",
      npxServers("pkg@1.2.3"),
      PERMIT_PINNED_NPX,
      true,
    ],
    ["a pinned npx permit rejects @latest", npxServers("pkg@latest"), PERMIT_PINNED_NPX, false],
    [
      "a forbid overrides a permit",
      untrustedServers,
      `${PERMIT_ANY_REMOTE}\n${FORBID_UNTRUSTED}`,
      false,
    ],
    [
      "a forbid leaves other servers alone",
      githubServers,
      `${PERMIT_ANY_REMOTE}\n${FORBID_UNTRUSTED}`,
      true,
    ],
    ["a permit scoped to this bot allows", githubServers, permitForBot("garden"), true],
    ["a permit scoped to another bot denies", githubServers, permitForBot("other"), false],
  ])("%s", (_name, servers, policy, allowed) => {
    expect(paths(checkMcpPolicy("garden", servers, policy ?? ""))).toEqual(
      allowed ? [] : [`mcp_servers.${Object.keys(servers)[0]}`],
    );
  });

  it("names the policy that forbids a server", () => {
    const [issue] = checkMcpPolicy(
      "garden",
      untrustedServers,
      `${PERMIT_ANY_REMOTE}\n${FORBID_UNTRUSTED}`,
    );
    expect(issue?.message).toMatch(/forbidden by policy repo\.1/);
  });

  it("denies every server when the policy does not parse", () => {
    const issues = checkMcpPolicy("garden", githubServers, "permit(");
    expect(issues).toEqual([
      { path: "mcp_servers.ghmcp", message: expect.stringMatching(/^operator policy is invalid/) },
    ]);
  });

  describe("with global and repo layers", () => {
    const ceiling = FORBID_UNLESS_GITHUB;

    it.each<[string, Parameters<typeof checkMcpPolicy>[1], PolicyLayers, string | undefined]>([
      [
        "a repo permit inside the global ceiling",
        githubServers,
        { global: ceiling, repo: PERMIT_GITHUB },
        undefined,
      ],
      [
        "a repo permit cannot lift a global forbid",
        untrustedServers,
        { global: ceiling, repo: PERMIT_ANY_REMOTE },
        "forbidden by policy global.0",
      ],
      ["a global permit alone authorizes", githubServers, { global: PERMIT_GITHUB }, undefined],
      [
        "a global permit is a default for repos with no policy",
        githubServers,
        { global: PERMIT_GITHUB, repo: "" },
        undefined,
      ],
      ["a repo permit alone authorizes", githubServers, { repo: PERMIT_GITHUB }, undefined],
      [
        "a ceiling alone permits nothing",
        githubServers,
        { global: ceiling },
        "not permitted by any policy",
      ],
    ])("%s", (_name, servers, layers, message) => {
      expect(checkMcpPolicy("garden", servers, layers).map((issue) => issue.message)).toEqual(
        message === undefined ? [] : [message],
      );
    });

    it("names the invalid layer", () => {
      const [issue] = checkMcpPolicy("garden", githubServers, {
        global: "permit(",
        repo: PERMIT_GITHUB,
      });
      expect(issue?.message).toMatch(/^operator policy is invalid: global: /);
    });
  });

  it("denies when a policy errors during evaluation", () => {
    const issues = checkMcpPolicy(
      "garden",
      githubServers,
      `${PERMIT_ANY_REMOTE}\nforbid(principal, action, resource) when { resource.missing == "x" };`,
    );
    expect(issues[0]?.message).toMatch(/policy evaluation failed/);
  });
});

describe("validateMcpPolicy", () => {
  it.each([PERMIT_GITHUB, PERMIT_PINNED_NPX, FORBID_UNTRUSTED, permitForBot("garden"), ""])(
    "accepts %j",
    (policy) => {
      expect(validateMcpPolicy(policy)).toEqual([]);
    },
  );

  it.each<[string, string]>([
    ["bad syntax", "permit("],
    [
      "an unknown attribute",
      'permit(principal, action, resource) when { resource.region == "us" };',
    ],
    ["an unknown action", 'permit(principal, action == Action::"Delete", resource);'],
    ["a type mismatch", 'permit(principal, action, resource) when { resource.pinned == "yes" };'],
  ])("rejects %s", (_name, policy) => {
    expect(validateMcpPolicy(policy)).not.toEqual([]);
  });
});

describe("this repo's .centaur/mcp-policy.cedar", async () => {
  const policy = readFileSync(".centaur/mcp-policy.cedar", "utf8");
  const { bot, mcp_servers } = await loadSelfConfig();

  it("validates against the schema", () => {
    expect(validateMcpPolicy(policy)).toEqual([]);
  });

  it("requires approval for the servers in the repo config", () => {
    expect(Object.keys(mcp_servers)).not.toEqual([]);
    expect(outcomeOf(evaluateMcpPolicy(bot, mcp_servers, policy))).toBe(APPROVAL_REQUIRED);
  });

  it.each([
    ["the read-write GitHub endpoint", githubServers],
    ["a non-GitHub host", untrustedServers],
  ])("denies %s", (_name, servers) => {
    expect(checkMcpPolicy(bot, servers, policy)).toHaveLength(1);
  });
});

describe("this repo's infra/mcp-policy.cedar", () => {
  const global = readFileSync("infra/mcp-policy.cedar", "utf8");
  const repo = readFileSync(".centaur/mcp-policy.cedar", "utf8");

  it("validates against the schema", () => {
    expect(validateMcpPolicy(global, "global")).toEqual([]);
  });

  it.each<[string, Parameters<typeof checkMcpPolicy>[1], boolean]>([
    ["an https remote server", githubServers, true],
    ["a pinned npx package", npxServers("pkg@1.2.3"), true],
    ["an unpinned npx package", npxServers("pkg@latest"), false],
  ])("as a ceiling over a permit-anything repo policy: %s", (_name, servers, allowed) => {
    const issues = checkMcpPolicy("garden", servers, {
      global,
      repo: `${PERMIT_ANY_REMOTE}\n${PERMIT_PINNED_NPX}`,
    });
    expect(issues).toHaveLength(allowed ? 0 : 1);
  });

  it.each<[string, string, string, boolean]>([
    ["a commit-pinned git source", `${GIT_REPO_URL}@${COMMIT_SHA}`, PERMIT_UVX, true],
    ["a branch git source", `${GIT_REPO_URL}@main`, PERMIT_UVX, false],
    [
      "a commit-pinned source named by the repo policy",
      `${GIT_REPO_URL}@${COMMIT_SHA}`,
      PERMIT_UVX_GIT_SOURCE,
      true,
    ],
    [
      "a different commit under a policy naming one",
      `${GIT_REPO_URL}@${"a".repeat(40)}`,
      PERMIT_UVX_GIT_SOURCE,
      false,
    ],
  ])("as a ceiling for uvx: %s", (_name, source, repo, allowed) => {
    const issues = checkMcpPolicy("garden", uvxGitServers(source), { global, repo });
    expect(issues).toHaveLength(allowed ? 0 : 1);
    if (!allowed && repo === PERMIT_UVX) expect(issues[0]?.message).toMatch(/forbidden by policy/);
  });

  it.each<[string, string, string, string]>([
    ["with admin approval", PERMIT_ANY_PINNED_APPROVED, "@" + COMMIT_SHA, APPROVAL_REQUIRED],
    ["with admin approval", PERMIT_ANY_PINNED_APPROVED, "@main", "forbidden by policy global.0"],
    ["without a human decision", PERMIT_ANY_PINNED, "@" + COMMIT_SHA, ALLOWED],
    ["without a human decision", PERMIT_ANY_PINNED, "@main", "forbidden by policy global.0"],
  ])("allow-any-pinned-local-server %s at %s", (_name, repo, ref, expected) => {
    const result = evaluateMcpPolicy("garden", uvxGitServers(`${GIT_REPO_URL}${ref}`), {
      global,
      repo,
    });
    expect(outcomeOf(result)).toBe(expected);
  });

  it("leaves this repo's own servers permitted", async () => {
    const { bot, mcp_servers } = await loadSelfConfig();
    expect(checkMcpPolicy(bot, mcp_servers, { global, repo })).toEqual([]);
  });
});

describe("evaluateMcpPolicy approval outcomes", () => {
  const ceiling = FORBID_UNLESS_GITHUB;

  it.each<[string, string | PolicyLayers, string]>([
    [
      "a forbid with a plain permit",
      `${PERMIT_ANY_REMOTE}\n${FORBID_ALL}`,
      "forbidden by policy repo.1",
    ],
    [
      "a forbid with an approval permit",
      `${PERMIT_WHEN_APPROVED}\n${FORBID_ALL}`,
      "forbidden by policy repo.1",
    ],
    [
      "a forbid that only matches before approval",
      `${PERMIT_WHEN_APPROVED}\n${FORBID_WHEN_NOT_APPROVED}`,
      "forbidden by policy repo.1",
    ],
    ["a permit that ignores approval", PERMIT_ANY_REMOTE, ALLOWED],
    [
      "a plain permit beside an approval permit",
      `${PERMIT_ANY_REMOTE}\n${PERMIT_WHEN_APPROVED}`,
      ALLOWED,
    ],
    [
      "a global plain permit with a repo approval permit",
      { global: PERMIT_ANY_REMOTE, repo: PERMIT_WHEN_APPROVED },
      ALLOWED,
    ],
    ["only a permit that needs approval", PERMIT_WHEN_APPROVED, APPROVAL_REQUIRED],
    [
      "a global default approval permit inside the ceiling",
      { global: `${ceiling}\n${PERMIT_WHEN_APPROVED}`, repo: "" },
      APPROVAL_REQUIRED,
    ],
    [
      "approval permits in both layers",
      { global: PERMIT_WHEN_APPROVED, repo: PERMIT_WHEN_APPROVED },
      APPROVAL_REQUIRED,
    ],
    ["no permit", PERMIT_PINNED_NPX, "not permitted by any policy"],
    [
      "a policy that is stricter on approval",
      PERMIT_WHEN_NOT_APPROVED,
      "not permitted by any policy",
    ],
    [
      "a plain permit and a permit only before approval",
      `${PERMIT_WHEN_NOT_APPROVED}\n${PERMIT_WHEN_APPROVED}`,
      ALLOWED,
    ],
  ])("%s", (_name, policy, expected) => {
    expect(outcomeOf(evaluateMcpPolicy("garden", githubServers, policy))).toBe(expected);
  });

  it.each<[string, PolicyLayers]>([
    ["a repo approval permit", { global: ceiling, repo: PERMIT_WHEN_APPROVED }],
    [
      "a global and a repo approval permit",
      { global: `${ceiling}\n${PERMIT_WHEN_APPROVED}`, repo: PERMIT_WHEN_APPROVED },
    ],
  ])("a global forbid binds over %s", (_name, layers) => {
    expect(outcomeOf(evaluateMcpPolicy("garden", untrustedServers, layers))).toBe(
      "forbidden by policy global.0",
    );
  });

  it("names the approval-required server by its approval key", () => {
    const { issues, approvals } = evaluateMcpPolicy("garden", githubServers, PERMIT_WHEN_APPROVED, [
      "mcp__ghmcp__*",
    ]);
    expect(issues).toEqual([]);
    expect(approvals).toEqual([
      {
        name: "ghmcp",
        key: mcpApprovalKey("ghmcp", githubServer, ["mcp__ghmcp__*"]),
      },
    ]);
  });

  it("reports each server's outcome separately", () => {
    const result = evaluateMcpPolicy(
      "garden",
      { ...githubServers, ...untrustedServers },
      `${PERMIT_WHEN_APPROVED}\n${FORBID_UNTRUSTED}`,
    );
    expect(result.approvals.map(({ name }) => name)).toEqual(["ghmcp"]);
    expect(result.issues.map(({ path }) => path)).toEqual(["mcp_servers.evil"]);
  });

  it.each([PERMIT_WHEN_APPROVED, PERMIT_WHEN_NOT_APPROVED, FORBID_WHEN_NOT_APPROVED])(
    "validates a policy that reads context.approved: %s",
    (policy) => {
      expect(validateMcpPolicy(policy)).toEqual([]);
    },
  );

  it("rejects an unknown context attribute", () => {
    expect(
      validateMcpPolicy("permit(principal, action, resource) when { context.reviewed };"),
    ).not.toEqual([]);
  });
});
