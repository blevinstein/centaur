import { describe, expect, it } from "vitest";
import { checkMcpPolicy, validateMcpPolicy } from "../src/config/index.js";
import { describeServer, isPinned } from "../src/config/mcp-policy.js";
import {
  docsSearchServer,
  FORBID_UNTRUSTED,
  forbidForBot,
  githubServer,
  githubServers,
  npxServers,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
  PERMIT_PINNED_NPX,
  permitForBot,
  untrustedServers,
} from "./helpers/mcp-policy-fixtures.js";

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
    expect(paths(checkMcpPolicy("garden", servers, { global: policy }))).toEqual(
      allowed ? [] : [`mcp_servers.${Object.keys(servers)[0]}`],
    );
  });

  it("names the policy that forbids a server", () => {
    const [issue] = checkMcpPolicy("garden", untrustedServers, {
      global: `${PERMIT_ANY_REMOTE}\n${FORBID_UNTRUSTED}`,
    });
    expect(issue?.message).toMatch(/forbidden by policy global\.1/);
  });

  it("denies every server when the policy does not parse", () => {
    const issues = checkMcpPolicy("garden", githubServers, { global: "permit(" });
    expect(issues).toEqual([
      { path: "mcp_servers.ghmcp", message: expect.stringMatching(/^operator policy is invalid/) },
    ]);
  });

  it("denies when a policy errors during evaluation", () => {
    const issues = checkMcpPolicy("garden", githubServers, {
      global: `${PERMIT_ANY_REMOTE}\nforbid(principal, action, resource) when { resource.missing == "x" };`,
    });
    expect(issues[0]?.message).toMatch(/policy evaluation failed/);
  });

  describe("merging global and bot policies", () => {
    it("lets a bot permit extend a global one", () => {
      const servers = { ...githubServers, ...npxServers("pkg@1.2.3") };
      expect(paths(checkMcpPolicy("garden", servers, { global: PERMIT_GITHUB }))).toEqual([
        "mcp_servers.docs",
      ]);
      expect(
        checkMcpPolicy("garden", servers, { global: PERMIT_GITHUB, bot: PERMIT_PINNED_NPX }),
      ).toEqual([]);
    });

    it("lets a bot permit stand without a global policy", () => {
      expect(checkMcpPolicy("garden", githubServers, { bot: PERMIT_GITHUB })).toEqual([]);
    });

    it("keeps a global forbid in force over a bot permit", () => {
      expect(
        paths(
          checkMcpPolicy("garden", untrustedServers, {
            global: FORBID_UNTRUSTED,
            bot: PERMIT_ANY_REMOTE,
          }),
        ),
      ).toEqual(["mcp_servers.evil"]);
    });

    it("lets a bot forbid restrict that bot only", () => {
      const sources = { global: PERMIT_GITHUB, bot: forbidForBot("garden") };
      expect(paths(checkMcpPolicy("garden", githubServers, sources))).toEqual([
        "mcp_servers.ghmcp",
      ]);
      expect(checkMcpPolicy("other", githubServers, sources)).toEqual([]);
    });

    it("denies when only the bot policy is malformed", () => {
      expect(
        checkMcpPolicy("garden", githubServers, { global: PERMIT_GITHUB, bot: "permit(" })[0]
          ?.message,
      ).toMatch(/bot policy/);
    });
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
