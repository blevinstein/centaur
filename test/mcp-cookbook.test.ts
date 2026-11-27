import { describe, expect, it } from "vitest";
import { evaluateMcpPolicy, validateMcpPolicy } from "../src/config/mcp-policy.js";
import { cookbookSnippets, remoteAt, stdioArgs } from "./helpers/cookbook-fixtures.js";
import { ALLOWED, APPROVAL_REQUIRED, outcomeOf } from "./helpers/mcp-policy-fixtures.js";

const DENIED = "not permitted by any policy";
const snippets = cookbookSnippets();
const URL = "https://mcp.example.com/mcp";

type Case = [id: string, matching: ReturnType<typeof remoteAt>, other: ReturnType<typeof remoteAt>];

const cases: Case[] = [
  ["remote-url", remoteAt(URL), remoteAt("https://mcp.example.com/other")],
  [
    "remote-host",
    remoteAt("https://mcp.example.com/any/path"),
    remoteAt("https://other.example.com/mcp"),
  ],
  [
    "npx-package",
    stdioArgs("npx", ["-y", "@example/docs-mcp@1.4.2"]),
    stdioArgs("npx", ["-y", "@example/docs-mcp@1.4.3"]),
  ],
  ["uvx-package", stdioArgs("uvx", ["example-mcp==1.4.2"]), stdioArgs("uvx", ["other-mcp==1.4.2"])],
  [
    "installed-binary",
    stdioArgs("example-mcp-server", ["--stdio"]),
    stdioArgs("other-mcp-server", ["--stdio"]),
  ],
];

const bypasses: [id: string, servers: ReturnType<typeof remoteAt>][] = [
  ["npx-package", stdioArgs("npx", ["-y", "other@1.0.0", "@example/docs-mcp@1.4.2"])],
  ["npx-package", stdioArgs("npx", ["-y", "@example/docs-mcp@1.4.2", "--extra"])],
  ["npx-package", stdioArgs("npx", ["@example/docs-mcp@1.4.2"])],
  ["npx-package", stdioArgs("npx", ["-y", "-y", "other@1.0.0", "@example/docs-mcp@1.4.2"])],
  ["npx-package", stdioArgs("npx", ["-y", "@example/docs-mcp@1.4.2", "--", "x"])],
  ["uvx-package", stdioArgs("uvx", ["other==1.0.0", "example-mcp==1.4.2"])],
  ["uvx-package", stdioArgs("uvx", ["example-mcp==1.4.2", "--extra"])],
  ["installed-binary", stdioArgs("example-mcp-server", ["--stdio", "--extra"])],
  ["installed-binary", stdioArgs("example-mcp-server", ["--other"])],
  ["installed-binary", stdioArgs("/tmp/example-mcp-server", ["--stdio"])],
];

describe("docs/mcp.md permit cookbook", () => {
  it.each(Object.keys(snippets))("%s is valid Cedar for the policy schema", (id) => {
    expect(validateMcpPolicy(snippets[id] as string)).toEqual([]);
  });

  it.each(cases)("%s permits a match and nothing else", (id, matching, other) => {
    expect(outcomeOf(evaluateMcpPolicy("my-bot", matching, snippets[id] as string))).toBe(ALLOWED);
    expect(outcomeOf(evaluateMcpPolicy("my-bot", other, snippets[id] as string))).toBe(DENIED);
  });

  it.each(cases)("%s-approved asks for a decision on a match", (id, matching, other) => {
    const policy = snippets[`${id}-approved`] as string;
    expect(outcomeOf(evaluateMcpPolicy("my-bot", matching, policy))).toBe(APPROVAL_REQUIRED);
    expect(outcomeOf(evaluateMcpPolicy("my-bot", other, policy))).toBe(DENIED);
  });

  it.each(bypasses)("%s does not match a changed argument list", (id, servers) => {
    for (const suffix of ["", "-approved"]) {
      const policy = snippets[`${id}${suffix}`] as string;
      expect(outcomeOf(evaluateMcpPolicy("my-bot", servers, policy))).toBe(DENIED);
    }
  });

  it.each(["remote-host", "remote-host-approved"])("the forbid ceiling beats %s", (id) => {
    const servers = remoteAt("https://mcp.example.com/admin/tools");
    const layers = { global: snippets["forbid-admin-path"], repo: snippets[id] };
    expect(outcomeOf(evaluateMcpPolicy("my-bot", servers, layers))).toMatch(/forbidden by policy/);
    expect(outcomeOf(evaluateMcpPolicy("my-bot", remoteAt(URL), layers))).not.toMatch(/forbidden/);
  });
});
