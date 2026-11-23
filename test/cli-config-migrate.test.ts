import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCentaurConfig } from "../src/config/index.js";
import { createCliHarness } from "./helpers/cli.js";
import {
  legacyConfigText,
  legacyConfigVariants,
  migrateConfigFile as migrate,
  migratedConfigText,
  unmigratableConfigs,
} from "./helpers/migration-fixtures.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

describe("config migrate", () => {
  it("moves the platform keys under platforms and keeps comments, order and formatting", async () => {
    const { path, result, text, cli } = await migrate(legacyConfigText);

    expect(result).toBeUndefined();
    expect(await text()).toBe(migratedConfigText);
    expect(cli.output.join("\n")).toContain(`Migrated ${path}`);
    expect(parseCentaurConfig(await text())).toMatchObject({
      ok: true,
      config: { platforms: { telegram: { respond_to: "all", handle: "sample_helper_bot" } } },
    });
  });

  it.each(Object.entries(legacyConfigVariants))(
    "migrates %s",
    async (_name, { legacy, migrated }) => {
      const { text } = await migrate(legacy);
      expect(await text()).toBe(migrated);
    },
  );

  it("is idempotent", async () => {
    const { path, cli, text } = await migrate(migratedConfigText);

    expect(await text()).toBe(migratedConfigText);
    expect(cli.output.join("\n")).toContain(`${path} already declares platforms`);
  });

  it("prints a diff and leaves the file alone with --dry-run", async () => {
    const { cli, text } = await migrate(legacyConfigText, "--dry-run");

    expect(await text()).toBe(legacyConfigText);
    const diff = cli.output.join("\n");
    expect(diff).toContain("-platform: telegram");
    expect(diff).toContain("+platforms:");
  });

  it.each(Object.entries(unmigratableConfigs))(
    "refuses %s and writes nothing",
    async (_name, original) => {
      const { result, text } = await migrate(original);

      expect(result).toBeInstanceOf(Error);
      expect(await text()).toBe(original);
    },
  );

  it("fails clearly when the file is missing", async () => {
    const { root } = await createWorkspace({});
    await expect(
      createCliHarness().run("config", "migrate", join(root, "none.yml")),
    ).rejects.toThrow(/Cannot read .*none\.yml: no such file/);
  });
});
