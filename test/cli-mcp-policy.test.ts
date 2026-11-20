import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";
import { FORBID_UNTRUSTED, PERMIT_GITHUB } from "./helpers/mcp-policy-fixtures.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

const GLOBAL = "/centaur/policy/mcp";
const GARDEN = "/centaur/bots/garden/mcp-policy";

async function harnessWithPolicyFile(text: string) {
  const { root } = await createWorkspace({ "policy.cedar": text });
  const cli = createCliHarness();
  cli.store.entries.set("/centaur/bots/garden/platform", { value: "telegram", secure: false });
  return { cli, file: join(root, "policy.cedar") };
}

describe("mcp-policy set", () => {
  it("stores a valid policy globally", async () => {
    const { cli, file } = await harnessWithPolicyFile(PERMIT_GITHUB);

    await cli.run("mcp-policy", "set", "--file", file);

    expect(cli.store.entries.get(GLOBAL)).toEqual({ value: PERMIT_GITHUB, secure: false });
  });

  it("stores a valid policy for one bot", async () => {
    const { cli, file } = await harnessWithPolicyFile(PERMIT_GITHUB);

    await cli.run("mcp-policy", "set", "--bot", "garden", "--file", file);

    expect(cli.store.entries.get(GARDEN)?.value).toBe(PERMIT_GITHUB);
    expect(cli.store.entries.has(GLOBAL)).toBe(false);
  });

  it("refuses an invalid policy and stores nothing", async () => {
    const { cli, file } = await harnessWithPolicyFile(
      'permit(principal, action, resource) when { resource.region == "us" };',
    );

    await expect(cli.run("mcp-policy", "set", "--file", file)).rejects.toThrow(/is invalid:\n.+/);
    expect(cli.store.entries.has(GLOBAL)).toBe(false);
  });

  it("refuses an unknown bot", async () => {
    const { cli, file } = await harnessWithPolicyFile(PERMIT_GITHUB);

    await expect(cli.run("mcp-policy", "set", "--bot", "ghost", "--file", file)).rejects.toThrow(
      /Unknown bot "ghost"/,
    );
  });

  it("fails clearly when the file is missing", async () => {
    const { cli } = await harnessWithPolicyFile("");

    await expect(cli.run("mcp-policy", "set", "--file", "/nonexistent.cedar")).rejects.toThrow(
      /Cannot read \/nonexistent\.cedar: no such file/,
    );
  });
});

describe("mcp-policy show", () => {
  it("reports an unset global policy", async () => {
    const { cli } = await harnessWithPolicyFile("");

    await cli.run("mcp-policy", "show");

    expect(cli.output).toEqual(["// global policy: not set"]);
  });

  it("prints the global policy and, with --bot, the bot policy after it", async () => {
    const { cli } = await harnessWithPolicyFile("");
    cli.store.entries.set(GLOBAL, { value: PERMIT_GITHUB, secure: false });
    cli.store.entries.set(GARDEN, { value: FORBID_UNTRUSTED, secure: false });

    await cli.run("mcp-policy", "show", "--bot", "garden");

    expect(cli.output).toEqual([
      `// global policy\n${PERMIT_GITHUB}\n\n// policy for bot "garden"\n${FORBID_UNTRUSTED}`,
    ]);
  });
});

describe("mcp-policy clear", () => {
  it("deletes the global policy only", async () => {
    const { cli } = await harnessWithPolicyFile("");
    cli.store.entries.set(GLOBAL, { value: PERMIT_GITHUB, secure: false });
    cli.store.entries.set(GARDEN, { value: PERMIT_GITHUB, secure: false });

    await cli.run("mcp-policy", "clear");

    expect(cli.store.entries.has(GLOBAL)).toBe(false);
    expect(cli.store.entries.has(GARDEN)).toBe(true);
  });

  it("deletes one bot's policy only", async () => {
    const { cli } = await harnessWithPolicyFile("");
    cli.store.entries.set(GLOBAL, { value: PERMIT_GITHUB, secure: false });
    cli.store.entries.set(GARDEN, { value: PERMIT_GITHUB, secure: false });

    await cli.run("mcp-policy", "clear", "--bot", "garden");

    expect(cli.store.entries.has(GARDEN)).toBe(false);
    expect(cli.store.entries.has(GLOBAL)).toBe(true);
  });

  it("fails when there is nothing to clear", async () => {
    const { cli } = await harnessWithPolicyFile("");

    await expect(cli.run("mcp-policy", "clear")).rejects.toThrow(/No global MCP policy is set/);
  });

  it("is removed along with the bot", async () => {
    const { cli } = await harnessWithPolicyFile("");
    cli.store.entries.set(GARDEN, { value: PERMIT_GITHUB, secure: false });

    await cli.run("bot", "remove", "garden");

    expect(cli.store.names()).toEqual([]);
  });
});
