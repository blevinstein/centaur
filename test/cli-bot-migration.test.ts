import { readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";
import {
  backupPath,
  flatAlias,
  flatBot,
  foldableBots,
  LossyParameterStore,
  NESTED_TELEGRAM,
  nestedNames,
  populated,
} from "./helpers/migration-fixtures.js";

describe("bot export and restore", () => {
  it("writes every bot parameter and alias to a private file and prints no values", async () => {
    const cli = populated();
    const path = await backupPath();

    await cli.run("bot", "export", path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const backup = JSON.parse(await readFile(path, "utf8"));
    expect(backup.version).toBe(1);
    expect(backup.parameters).toHaveLength(cli.store.names().length);
    expect(backup.parameters).toContainEqual({
      name: "/centaur/bots/sample/token",
      value: "tg-token",
      secure: true,
    });
    expect(cli.output.join("\n")).toContain(`${cli.store.names().length} parameters`);
    expect(cli.output.join("\n")).not.toContain("tg-token");
  });

  it("refuses to overwrite an export unless forced", async () => {
    const cli = populated();
    const path = await backupPath();
    await writeFile(path, "old", { mode: 0o644 });

    await expect(cli.run("bot", "export", path)).rejects.toThrow(/already exists/);
    await cli.run("bot", "export", path, "--force");

    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("restores into an empty store and again without change", async () => {
    const source = populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const target = createCliHarness();

    await target.run("bot", "restore", path);
    await target.run("bot", "restore", path);

    expect(target.store.entries).toEqual(source.store.entries);
    expect(target.output[1]).toContain("0 overwritten");
  });

  it("refuses a differing parameter unless forced, naming it but not its value", async () => {
    const source = populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const target = createCliHarness();
    await target.connect("sample", "telegram", "other");
    target.store.entries.set("/centaur/bots/sample/token", { value: "changed", secure: true });

    await expect(target.run("bot", "restore", path)).rejects.toThrow(
      /1 parameters already exist[\s\S]*\/centaur\/bots\/sample\/token(?![\s\S]*changed)/,
    );
    expect(target.store.entries.get("/centaur/bots/sample/token")?.value).toBe("changed");

    await target.run("bot", "restore", path, "--force");
    expect(target.store.entries.get("/centaur/bots/sample/token")?.value).toBe("tg-token");
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
    const source = populated();
    const path = await backupPath();
    await source.run("bot", "export", path);
    const cli = createCliHarness(
      {},
      undefined,
      new LossyParameterStore("/centaur/bots/sample/token"),
    );

    await expect(cli.run("bot", "restore", path)).rejects.toThrow(/Verification failed: .*token/);
  });
});

describe("bot migrate", () => {
  it("copies the flat layout to the nested one, verified, leaving the flat parameters", async () => {
    const cli = populated();
    const flat = cli.store.names();

    await cli.run("bot", "migrate");

    expect(cli.store.names()).toEqual(
      [
        ...flat,
        `${NESTED_TELEGRAM}/token`,
        `${NESTED_TELEGRAM}/webhook-secret`,
        `${NESTED_TELEGRAM}/approved-chats/-100`,
        `${NESTED_TELEGRAM}/approved-users/7`,
        `${NESTED_TELEGRAM}/blocked/user/9`,
        "/centaur/chats/telegram/household",
      ].sort(),
    );
    expect(cli.store.entries.get(`${NESTED_TELEGRAM}/token`)).toEqual({
      value: "tg-token",
      secure: true,
    });
    expect(cli.store.entries.get("/centaur/chats/telegram/household")?.value).toBe("-100");
    expect(cli.output.join("\n")).not.toContain("tg-token");
    expect(cli.output.join("\n")).toContain("registry entry is not migrated");
  });

  it("writes nothing with --dry-run and reports an alias whose platform is unknown", async () => {
    const cli = populated();
    flatAlias(cli.store, "orphan", "-999");
    const before = new Map(cli.store.entries);

    await cli.run("bot", "migrate", "--dry-run");

    expect(cli.store.entries).toEqual(before);
    const output = cli.output.join("\n");
    expect(output).toContain(`would copy /centaur/bots/sample/token -> ${NESTED_TELEGRAM}/token`);
    expect(output).toContain(
      'unresolved alias "orphan" (chat -999): no bot has approved this chat',
    );
    expect(output).not.toContain("tg-token");
  });

  it("refuses to copy anything while an alias is unresolved, then accepts --alias-platform or --drop-alias", async () => {
    const cli = populated();
    flatAlias(cli.store, "orphan", "-999");
    const before = new Map(cli.store.entries);

    await expect(cli.run("bot", "migrate")).rejects.toThrow(/Nothing was changed[\s\S]*orphan/);
    expect(cli.store.entries).toEqual(before);

    await cli.run("bot", "migrate", "--alias-platform", "orphan=slack");
    expect(cli.store.entries.get("/centaur/chats/slack/orphan")?.value).toBe("-999");

    const dropped = populated();
    flatAlias(dropped.store, "orphan", "-999");
    await dropped.run("bot", "migrate", "--drop-alias", "orphan");
    expect(dropped.store.names()).not.toContain("/centaur/chats/slack/orphan");
  });

  it("reports an alias approved on two platforms as ambiguous", async () => {
    const cli = populated();
    flatBot(cli.store, "other", "slack", { "approved-chats/-100": '{"at":"x"}' });

    await cli.run("bot", "migrate", "--dry-run");

    expect(cli.output.join("\n")).toContain("approved on telegram and slack");
  });

  it.each([
    [["--alias-platform", "household"], /expected <alias>=<platform>/],
    [["--alias-platform", "household=irc"], /Unknown platform/],
    [["--alias-platform", "missing=slack"], /no flat chat alias "missing"/],
    [["--drop-alias", "missing"], /no flat chat alias "missing"/],
  ])("rejects the option %j", async (args, message) => {
    await expect(populated().run("bot", "migrate", ...args)).rejects.toThrow(message);
  });

  it("is idempotent and keeps nested values that have since changed", async () => {
    const cli = populated();
    await cli.run("bot", "migrate");
    cli.store.entries.set(`${NESTED_TELEGRAM}/approved-users/7`, {
      value: "edited",
      secure: false,
    });
    const before = new Map(cli.store.entries);
    cli.output.length = 0;

    await cli.run("bot", "migrate");

    expect(cli.store.entries).toEqual(before);
    expect(cli.output.join("\n")).toContain("1 differ and were kept");
  });

  it("copies only what is missing on a second pass", async () => {
    const cli = populated();
    await cli.run("bot", "migrate");
    cli.store.entries.set("/centaur/bots/sample/approved-chats/-200", {
      value: "{}",
      secure: false,
    });

    await cli.run("bot", "migrate");

    expect(cli.store.names()).toContain(`${NESTED_TELEGRAM}/approved-chats/-200`);
  });

  it("refuses a flat bot without a valid platform and lists unrecognized parameters", async () => {
    const cli = createCliHarness();
    cli.store.entries.set("/centaur/bots/sample/token", { value: "t", secure: true });
    cli.store.entries.set("/centaur/bots/sample/mystery", { value: "x", secure: false });

    await expect(cli.run("bot", "migrate")).rejects.toThrow(/no valid platform parameter/);
    await cli.run("bot", "migrate", "--dry-run");
    expect(cli.output.join("\n")).toContain(
      "skipped unrecognized parameter /centaur/bots/sample/mystery",
    );
  });

  it("fails when a copy does not read back", async () => {
    const lossy = new LossyParameterStore(`${NESTED_TELEGRAM}/token`);
    const cli = createCliHarness({}, undefined, lossy);
    flatBot(cli.store, "sample", "telegram");

    await expect(cli.run("bot", "migrate")).rejects.toThrow(/Verification failed: .*token/);
  });

  describe("--prune", () => {
    it("deletes the flat parameters and aliases once the secrets are copied, keeping the rest", async () => {
      const cli = populated();
      cli.store.entries.set("/centaur/bots/sample/mystery", { value: "x", secure: false });
      await cli.run("bot", "migrate");

      await cli.run("bot", "migrate", "--prune");

      expect(cli.store.names()).toEqual(
        ["/centaur/bots/sample/repo", "/centaur/bots/sample/mystery", ...nestedNames(cli)].sort(),
      );
      expect(cli.store.names()).toContain("/centaur/chats/telegram/household");
    });

    it("refuses while a secret is not copied unchanged, and deletes nothing", async () => {
      const cli = populated();
      const before = new Map(cli.store.entries);

      await expect(cli.run("bot", "migrate", "--prune")).rejects.toThrow(
        /6 flat parameters have no identical nested copy[\s\S]*token/,
      );
      expect(cli.store.entries).toEqual(before);
    });

    it("lists the deletions with --dry-run and deletes nothing", async () => {
      const cli = populated();
      await cli.run("bot", "migrate");
      const before = new Map(cli.store.entries);
      cli.output.length = 0;

      await cli.run("bot", "migrate", "--prune", "--dry-run");

      expect(cli.store.entries).toEqual(before);
      expect(cli.output.join("\n")).toContain("would delete /centaur/chats/household");
    });

    it.each([
      ["a nested approval differs", `${NESTED_TELEGRAM}/approved-users/7`, "edited"],
      ["a nested alias is missing", "/centaur/chats/telegram/household", undefined],
    ])("refuses and deletes nothing when %s", async (_name, nested, value) => {
      const cli = populated();
      await cli.run("bot", "migrate");
      if (value === undefined) cli.store.entries.delete(nested);
      else cli.store.entries.set(nested, { value, secure: false });
      const before = new Map(cli.store.entries);

      await expect(cli.run("bot", "migrate", "--prune")).rejects.toThrow(
        new RegExp(`1 flat parameters have no identical nested copy[\\s\\S]*${nested}`),
      );
      expect(cli.store.entries).toEqual(before);

      cli.output.length = 0;
      await cli.run("bot", "migrate", "--prune", "--dry-run");
      expect(cli.output.join("\n")).toContain(`blocked by ${nested}`);
      expect(cli.output.join("\n")).not.toContain("edited");
    });

    it("is a no-op when run again after a prune", async () => {
      const cli = populated();
      await cli.run("bot", "migrate");
      await cli.run("bot", "migrate", "--prune");
      const before = new Map(cli.store.entries);

      await cli.run("bot", "migrate", "--prune");

      expect(cli.store.entries).toEqual(before);
    });

    it("refuses while an alias is unresolved", async () => {
      const cli = populated();
      await cli.run("bot", "migrate");
      flatAlias(cli.store, "orphan", "-999");

      await expect(cli.run("bot", "migrate", "--prune")).rejects.toThrow(/orphan/);
    });
  });
});

describe("bot adopt", () => {
  it("copies a connection to the target and leaves the source untouched", async () => {
    const cli = await foldableBots();
    const source = await cli.store.getByPath("/centaur/bots/folded/platforms/slack/");

    await cli.run("bot", "adopt", "folded", "main");

    for (const { name, value, secure } of source) {
      expect(cli.store.entries.get(name.replace("/folded/", "/main/"))).toEqual({ value, secure });
      expect(cli.store.entries.get(name)).toEqual({ value, secure });
    }
    expect(cli.output.join("\n")).toContain("start fresh");
    expect(cli.output.join("\n")).not.toContain("sl-token");
  });

  it("refuses when the target already has that platform, is unknown, or equals the source", async () => {
    const cli = await foldableBots();
    await cli.run("bot", "adopt", "folded", "main");

    await expect(cli.run("bot", "adopt", "folded", "main")).rejects.toThrow(
      /already has a slack connection/,
    );
    await expect(cli.run("bot", "adopt", "folded", "nobody")).rejects.toThrow(
      /Unknown bot "nobody"/,
    );
    await expect(cli.run("bot", "adopt", "folded", "folded")).rejects.toThrow(/must differ/);
    await expect(cli.run("bot", "adopt", "nobody", "main")).rejects.toThrow(/Unknown bot "nobody"/);
  });

  it("needs --platform when the source has several connections", async () => {
    const cli = await foldableBots();
    await cli.connect("folded", "telegram");

    await expect(cli.run("bot", "adopt", "folded", "main")).rejects.toThrow(/pass --platform/);
  });
});
