import { readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  backupPath,
  LossyParameterStore,
  populated,
  TOKEN_PARAMETER,
} from "./helpers/backup-fixtures.js";
import { createCliHarness } from "./helpers/cli.js";

describe("bot export and restore", () => {
  it("writes every bot parameter and chat to a private file and prints no values", async () => {
    const cli = await populated();
    const path = await backupPath();

    await cli.run("bot", "export", path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const backup = JSON.parse(await readFile(path, "utf8"));
    expect(backup.version).toBe(1);
    expect(backup.parameters).toHaveLength(cli.store.names().length);
    expect(backup.parameters).toContainEqual({
      name: TOKEN_PARAMETER,
      value: "tg-token",
      secure: true,
    });
    expect(cli.output.join("\n")).toContain(`${cli.store.names().length} parameters`);
    expect(cli.output.join("\n")).not.toContain("tg-token");
  });

  it("refuses to overwrite an export unless forced", async () => {
    const cli = await populated();
    const path = await backupPath();
    await writeFile(path, "old", { mode: 0o644 });

    await expect(cli.run("bot", "export", path)).rejects.toThrow(/already exists/);
    await cli.run("bot", "export", path, "--force");

    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("restores into an empty store and again without change", async () => {
    const source = await populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const target = createCliHarness();

    await target.run("bot", "restore", path);
    await target.run("bot", "restore", path);

    expect(target.store.entries).toEqual(source.store.entries);
    expect(target.output[1]).toContain("0 overwritten");
  });

  it("refuses a differing parameter unless forced, naming it but not its value", async () => {
    const source = await populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const target = createCliHarness();
    target.store.entries.set(TOKEN_PARAMETER, { value: "changed", secure: true });

    await expect(target.run("bot", "restore", path)).rejects.toThrow(
      /1 parameters already exist[\s\S]*\/platforms\/telegram\/token(?![\s\S]*changed)/,
    );
    expect(target.store.entries.get(TOKEN_PARAMETER)?.value).toBe("changed");

    await target.run("bot", "restore", path, "--force");
    expect(target.store.entries.get(TOKEN_PARAMETER)?.value).toBe("tg-token");
  });

  it.each([
    ["not JSON", "nope", /not valid JSON/],
    ["a wrong version", '{"version":2,"exportedAt":"x","parameters":[]}', /version 1/],
    [
      "a parameter outside the backup scope",
      '{"version":1,"exportedAt":"x","parameters":[{"name":"/other/x","value":"v","secure":false}]}',
      /outside its scope: \/other\/x/,
    ],
  ])("rejects a backup that is %s", async (_name, text, message) => {
    const path = await backupPath();
    await writeFile(path, text);
    const cli = createCliHarness();

    await expect(cli.run("bot", "restore", path)).rejects.toThrow(message);
    expect(cli.store.names()).toEqual([]);
  });

  it("fails verification when a restored parameter does not read back", async () => {
    const source = await populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const cli = createCliHarness({}, undefined, new LossyParameterStore(TOKEN_PARAMETER));

    await expect(cli.run("bot", "restore", path)).rejects.toThrow(/Verification failed: .*token/);
  });
});
