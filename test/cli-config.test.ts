import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILES } from "../src/workflows/config-file.js";
import { createCliHarness } from "./helpers/cli.js";
import { invalidConfigs, minimalConfig, withMcp } from "./helpers/config-fixtures.js";
import {
  FORBID_UNLESS_GITHUB,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
} from "./helpers/mcp-policy-fixtures.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

const servers = withMcp("  linear:\n    url: https://mcp.linear.app/mcp", "mcp__linear__*");

describe("config check", () => {
  afterEach(() => vi.restoreAllMocks());

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

  describe.each(CONFIG_FILES)("with the config at %s", (configFile) => {
    it("resolves the file from the current directory when no path is given", async () => {
      const { root } = await createWorkspace({ [configFile]: minimalConfig });
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const cli = createCliHarness();

      await cli.run("config", "check");

      expect(cli.output.join("\n")).toContain(`${join(root, configFile)} is valid`);
    });

    it("reads the policy at the repo root", async () => {
      const { root } = await createWorkspace({
        [configFile]: servers,
        ".centaur/mcp-policy.cedar": PERMIT_ANY_REMOTE,
      });
      await expect(
        createCliHarness().run("config", "check", join(root, configFile)),
      ).resolves.not.toThrow();
    });
  });

  it("fails with no path when both config files exist", async () => {
    const { root } = await createWorkspace({
      ".centaur.yml": minimalConfig,
      ".centaur/config.yml": minimalConfig,
    });
    vi.spyOn(process, "cwd").mockReturnValue(root);

    await expect(createCliHarness().run("config", "check")).rejects.toThrow(/remove one/);
  });

  describe("with mcp_servers", () => {
    const check = async (files: Record<string, string>, ...flags: string[]) => {
      const { root } = await createWorkspace({ ".centaur.yml": servers, ...files });
      return createCliHarness().run("config", "check", join(root, ".centaur.yml"), ...flags);
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

    it("applies a global policy given by path", async () => {
      const { root } = await createWorkspace({ "global.cedar": FORBID_UNLESS_GITHUB });

      await expect(
        check(
          { ".centaur/mcp-policy.cedar": PERMIT_ANY_REMOTE },
          "--global-policy",
          join(root, "global.cedar"),
        ),
      ).rejects.toThrow(/mcp_servers\.linear: forbidden by policy global\.0/);
    });

    it("fails when the global policy cannot be read", async () => {
      await expect(
        check(
          { ".centaur/mcp-policy.cedar": PERMIT_ANY_REMOTE },
          "--global-policy",
          "/nonexistent.cedar",
        ),
      ).rejects.toThrow(/Cannot read \/nonexistent\.cedar/);
    });

    it("fails when there is no policy file", async () => {
      await expect(check({})).rejects.toThrow(/cannot be read/);
    });
  });
});
