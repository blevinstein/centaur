import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkMcpPolicy,
  describeServer,
  isPinned,
  type PolicyLayers,
  validateMcpPolicy,
} from "../src/config/mcp-policy.js";
import {
  docsSearchServer,
  FORBID_UNLESS_GITHUB,
  FORBID_UNTRUSTED,
  githubServer,
  githubServers,
  npxServers,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
  PERMIT_PINNED_NPX,
  permitForBot,
  untrustedServers,
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

  it("permits the servers in the repo config", () => {
    expect(Object.keys(mcp_servers)).not.toEqual([]);
    expect(checkMcpPolicy(bot, mcp_servers, policy)).toEqual([]);
  });

  it("denies the read-write GitHub endpoint", () => {
    expect(checkMcpPolicy(bot, githubServers, policy)).toHaveLength(1);
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

  it("leaves this repo's own servers permitted", async () => {
    const { bot, mcp_servers } = await loadSelfConfig();
    expect(checkMcpPolicy(bot, mcp_servers, { global, repo })).toEqual([]);
  });
});
