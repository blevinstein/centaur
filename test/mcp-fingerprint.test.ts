import { describe, expect, it } from "vitest";
import { mcpApprovalKey } from "../src/config/mcp-fingerprint.js";
import { mcpServersFrom } from "./helpers/config-fixtures.js";
import { LOCAL_SERVER_VARIANTS, REMOTE_SERVER_VARIANTS } from "./helpers/mcp-policy-fixtures.js";

const keyFor = (
  yaml: string,
  name: string,
  allowedTools: string[] = [`mcp__${name}__*`],
): string => {
  const server = mcpServersFrom(yaml)[name];
  if (!server) throw new Error(`missing fixture server ${name}`);
  return mcpApprovalKey(name, server, allowedTools);
};

describe.each([
  [
    "a remote server",
    "linear",
    REMOTE_SERVER_VARIANTS,
    ["headerOrder"],
    ["url", "plainHeader", "secretName"],
  ],
  [
    "a local server",
    "docs-search",
    LOCAL_SERVER_VARIANTS,
    ["envOrder"],
    ["command", "args", "plainEnv", "secretName"],
  ],
] as const)("mcpApprovalKey for %s", (_label, name, variants, unchanged, changed) => {
  const base = keyFor(variants.base, name);

  it("is <name>:<16 hex> and deterministic", () => {
    expect(base).toMatch(new RegExp(`^${name}:[0-9a-f]{16}$`));
    expect(keyFor(variants.base, name)).toBe(base);
  });

  it.each(unchanged)("ignores %s ordering", (variant) => {
    expect(keyFor(variants[variant as keyof typeof variants], name)).toBe(base);
  });

  it.each(changed)("changes with the %s", (variant) => {
    expect(keyFor(variants[variant as keyof typeof variants], name)).not.toBe(base);
  });

  it("changes with an allowed_tools entry naming the server", () => {
    expect(keyFor(variants.base, name, [`mcp__${name}__*`, `mcp__${name}__delete`])).not.toBe(base);
  });

  it("ignores allowed_tools entries naming other servers and built-in tools", () => {
    expect(keyFor(variants.base, name, [`mcp__${name}__*`, "mcp__other__*", "Read"])).toBe(base);
  });

  it("ignores the order of allowed_tools entries", () => {
    const tools = [`mcp__${name}__a`, `mcp__${name}__b`];
    expect(keyFor(variants.base, name, tools)).toBe(
      keyFor(variants.base, name, [...tools].reverse()),
    );
  });
});
