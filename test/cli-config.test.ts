import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";
import { invalidConfigs, minimalConfig } from "./helpers/config-fixtures.js";
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
});
