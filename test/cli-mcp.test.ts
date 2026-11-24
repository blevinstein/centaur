import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";

async function harness() {
  const cli = createCliHarness();
  await cli.connect("garden", "telegram");
  await cli.connect("other", "telegram");
  await cli.approveMcp("garden", "search", "bbb222");
  await cli.approveMcp("garden", "search", "aaa111", "2026-02-03T04:05:06.000Z");
  await cli.approveMcp("garden", "files", "ccc333");
  await cli.approveMcp("other", "search", "aaa111");
  return cli;
}

const gardenSearch = (fingerprint: string) =>
  `/centaur/bots/garden/mcp-approvals/search/${fingerprint}`;

describe("mcp approvals", () => {
  it("lists a bot's approvals ordered by name then fingerprint", async () => {
    const cli = await harness();

    await cli.run("mcp", "approvals", "garden");

    expect(cli.output).toEqual([
      [
        "files  ccc333  2026-01-02T03:04:05.000Z  U1",
        "search  aaa111  2026-02-03T04:05:06.000Z  U1",
        "search  bbb222  2026-01-02T03:04:05.000Z  U1",
      ].join("\n"),
    ]);
  });

  it("says so when nothing is approved", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");

    await cli.run("mcp", "approvals", "garden");

    expect(cli.output).toEqual(['No MCP servers approved for "garden".']);
  });

  it("rejects an unknown bot", async () => {
    await expect((await harness()).run("mcp", "approvals", "nope")).rejects.toThrow(
      'Unknown bot "nope"',
    );
  });
});

describe("mcp revoke", () => {
  it("removes every fingerprint of the named server only", async () => {
    const cli = await harness();

    await cli.run("mcp", "revoke", "garden", "search");

    expect(cli.store.names().filter((name) => name.includes("mcp-approvals"))).toEqual([
      "/centaur/bots/garden/mcp-approvals/files/ccc333",
      "/centaur/bots/other/mcp-approvals/search/aaa111",
    ]);
    expect(cli.output[0]).toContain("aaa111");
    expect(cli.output[0]).toContain("bbb222");
  });

  it("removes one definition with --fingerprint", async () => {
    const cli = await harness();

    await cli.run("mcp", "revoke", "garden", "search", "--fingerprint", "aaa111");

    expect(cli.store.entries.has(gardenSearch("aaa111"))).toBe(false);
    expect(cli.store.entries.has(gardenSearch("bbb222"))).toBe(true);
  });

  it.each([[["missing"]], [["search", "--fingerprint", "zzz"]]])(
    "errors and deletes nothing for %j",
    async (args) => {
      const cli = await harness();
      const before = cli.store.names();

      await expect(cli.run("mcp", "revoke", "garden", ...args)).rejects.toThrow("No approval");

      expect(cli.store.names()).toEqual(before);
    },
  );
});
