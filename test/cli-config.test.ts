import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";
import { invalidConfigs, minimalConfig, withMcp } from "./helpers/config-fixtures.js";
import { PERMIT_ANY_REMOTE, PERMIT_GITHUB } from "./helpers/mcp-policy-fixtures.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

describe("config check", () => {
  it("reports a valid file and touches no parameters", async () => {
    const { root } = await createWorkspace({ ".centaur.yml": minimalConfig });
    const cli = createCliHarness();

    await cli.run("config", "check", join(root, ".centaur.yml"));

    expect(cli.output.join("\n")).toContain("is valid");
    expect(cli.store.names()).toEqual([]);
  });

  it("lists every issue and fails on an invalid file", async () => {
    const [, text, path] = invalidConfigs[0] as (typeof invalidConfigs)[number];
    const { root } = await createWorkspace({ "bad.yml": text });
    const cli = createCliHarness();

    await expect(cli.run("config", "check", join(root, "bad.yml"))).rejects.toThrow(
      new RegExp(`is invalid:\\n.*${path}`),
    );
  });

  it("fails on malformed YAML", async () => {
    const { root } = await createWorkspace({ "bad.yml": "bot: [unclosed" });
    const cli = createCliHarness();

    await expect(cli.run("config", "check", join(root, "bad.yml"))).rejects.toThrow(/is invalid/);
  });

  it("fails clearly when the file is missing", async () => {
    const { root } = await createWorkspace({});
    const cli = createCliHarness();

    await expect(cli.run("config", "check", join(root, ".centaur.yml"))).rejects.toThrow(
      /Cannot read .*\.centaur\.yml: no such file/,
    );
  });

  describe("with mcp_servers", () => {
    const servers = withMcp("  linear:\n    url: https://mcp.linear.app/mcp", "mcp__linear__*");
    const check = async (files: Record<string, string>) => {
      const { root } = await createWorkspace({ ".centaur.yml": servers, ...files });
      return createCliHarness().run("config", "check", join(root, ".centaur.yml"));
    };

    it("accepts servers the sibling policy permits", async () => {
      await expect(
        check({ ".centaur/mcp-policy.cedar": PERMIT_ANY_REMOTE }),
      ).resolves.not.toThrow();
    });

    it("fails naming each server the policy does not permit", async () => {
      await expect(check({ ".centaur/mcp-policy.cedar": PERMIT_GITHUB })).rejects.toThrow(
        /mcp_servers\.linear: not permitted by any policy/,
      );
    });

    it("fails on an invalid policy", async () => {
      await expect(check({ ".centaur/mcp-policy.cedar": "permit(" })).rejects.toThrow(
        /mcp-policy\.cedar: /,
      );
    });

    it("fails when there is no policy file", async () => {
      await expect(check({})).rejects.toThrow(/cannot be read/);
    });
  });
});
