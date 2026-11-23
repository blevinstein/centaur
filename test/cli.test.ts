import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";

const TELEGRAM = "/centaur/bots/garden/platforms/telegram";
const SLACK = "/centaur/bots/garden/platforms/slack";

describe("bot add", () => {
  it("stores a telegram token and a generated webhook secret as secure parameters", async () => {
    const cli = createCliHarness({ token: "123:abc" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");

    expect(cli.store.names()).toEqual([`${TELEGRAM}/token`, `${TELEGRAM}/webhook-secret`]);
    expect(cli.store.entries.get(`${TELEGRAM}/token`)).toEqual({
      value: "123:abc",
      secure: true,
    });
    const secret = cli.store.entries.get(`${TELEGRAM}/webhook-secret`);
    expect(secret?.secure).toBe(true);
    expect(secret?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cli.output.join("\n")).not.toContain("123:abc");
    expect(cli.output.join("\n")).not.toContain(secret?.value ?? "");
  });

  it("generates a different webhook secret per bot", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "a", "--platform", "telegram");
    await cli.run("bot", "add", "b", "--platform", "telegram");
    expect(
      cli.store.entries.get("/centaur/bots/a/platforms/telegram/webhook-secret")?.value,
    ).not.toBe(cli.store.entries.get("/centaur/bots/b/platforms/telegram/webhook-secret")?.value);
  });

  it("stores the signing secret for slack and generates nothing", async () => {
    const cli = createCliHarness({ token: "xoxb-1", "signing-secret": "sig" });
    await cli.run("bot", "add", "notes", "--platform", "slack");
    expect(cli.store.names()).toEqual([
      "/centaur/bots/notes/platforms/slack/signing-secret",
      "/centaur/bots/notes/platforms/slack/token",
    ]);
  });

  it("adds a second platform to an existing bot without touching the first", async () => {
    const cli = createCliHarness({ token: "t", "signing-secret": "sig" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    const before = new Map(cli.store.entries);

    await cli.run("bot", "add", "garden", "--platform", "slack");

    expect(cli.store.names()).toEqual([
      `${SLACK}/signing-secret`,
      `${SLACK}/token`,
      `${TELEGRAM}/token`,
      `${TELEGRAM}/webhook-secret`,
    ]);
    for (const [name, entry] of before) expect(cli.store.entries.get(name)).toEqual(entry);
  });

  it.each([
    [["bot", "add", "garden", "--platform", "irc"], /Unknown platform/],
    [["bot", "add", "Bad/Name", "--platform", "telegram"], /Invalid bot name/],
  ])("rejects %j", async (args, message) => {
    const cli = createCliHarness({ token: "t" });
    await expect(cli.run(...args)).rejects.toThrow(message);
    expect(cli.store.names()).toEqual([]);
  });

  it("refuses a second connection on the same platform, changing nothing", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    const before = cli.store.names();
    await expect(cli.run("bot", "add", "garden", "--platform", "telegram")).rejects.toThrow(
      /already has a telegram connection/,
    );
    expect(cli.store.names()).toEqual(before);
  });
});

describe("bot remove and unbind", () => {
  async function addBoundBot() {
    const cli = createCliHarness({ token: "t", "signing-secret": "sig" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await cli.run("bot", "add", "other", "--platform", "telegram");
    await cli.bind("garden", "me/garden");
    return cli;
  }

  it("refuses to remove a bound bot, then removes it after unbinding", async () => {
    const cli = await addBoundBot();
    await expect(cli.run("bot", "remove", "garden")).rejects.toThrow(/bound to me\/garden/);

    await cli.run("bot", "unbind", "garden");
    expect(await cli.store.get("/centaur/bots/garden/repo")).toBeUndefined();
    expect(await cli.store.get(`${TELEGRAM}/token`)).toBe("t");

    await cli.run("bot", "remove", "garden");
    expect(cli.store.names().filter((name) => name.includes("/garden/"))).toEqual([]);
    expect(cli.store.names()).toContain("/centaur/bots/other/platforms/telegram/token");
  });

  it("does not match bots whose names share a prefix", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await cli.run("bot", "add", "garden-2", "--platform", "telegram");
    await cli.run("bot", "remove", "garden");
    expect(cli.store.names()).toContain("/centaur/bots/garden-2/platforms/telegram/token");
  });

  it.each([
    ["remove", /Unknown bot/],
    ["unbind", /Unknown bot/],
  ])("%s fails for an unknown bot", async (command, message) => {
    const cli = createCliHarness();
    await expect(cli.run("bot", command, "ghost")).rejects.toThrow(message);
  });

  it("removes orphan parameters left without a connection", async () => {
    const cli = await addBoundBot();
    await cli.store.put("/centaur/bots/other/platforms/telegram/approved-chats/1", "{}", {
      secure: false,
    });
    await cli.store.delete(["/centaur/bots/other/platforms/telegram/token"]);
    await cli.store.delete(["/centaur/bots/other/platforms/telegram/webhook-secret"]);
    await cli.run("bot", "remove", "other");
    expect(cli.store.names().filter((name) => name.includes("/other/"))).toEqual([]);
  });

  it("unbind fails for an unbound bot", async () => {
    const cli = await addBoundBot();
    await expect(cli.run("bot", "unbind", "other")).rejects.toThrow(/not bound/);
  });

  describe("with several connections", () => {
    async function addTwoConnections() {
      const cli = await addBoundBot();
      await cli.run("bot", "add", "garden", "--platform", "slack");
      await cli.store.put(`${SLACK}/approved-chats/C1`, "{}", { secure: false });
      await cli.store.put(`${TELEGRAM}/approved-chats/-1`, "{}", { secure: false });
      return cli;
    }

    it("removes only the named connection, even while the bot is bound", async () => {
      const cli = await addTwoConnections();

      await cli.run("bot", "remove", "garden", "--platform", "slack");

      expect(cli.store.names().filter((name) => name.startsWith(SLACK))).toEqual([]);
      expect(cli.store.names()).toEqual(
        expect.arrayContaining([
          `${TELEGRAM}/token`,
          `${TELEGRAM}/approved-chats/-1`,
          "/centaur/bots/garden/repo",
        ]),
      );
      expect(cli.output.at(-1)).toBe('Removed the slack connection from bot "garden".');
    });

    it("requires --platform", async () => {
      const cli = await addTwoConnections();
      const before = cli.store.names();
      await expect(cli.run("bot", "remove", "garden")).rejects.toThrow(
        /several connections \(.*telegram.*slack.*\); pass --platform/,
      );
      expect(cli.store.names()).toEqual(before);
    });

    it("refuses a platform the bot is not on", async () => {
      const cli = await addBoundBot();
      await expect(cli.run("bot", "remove", "garden", "--platform", "slack")).rejects.toThrow(
        /no slack connection/,
      );
    });

    it("removes the whole bot with its last connection, unless it is bound", async () => {
      const cli = await addTwoConnections();
      await cli.run("bot", "remove", "garden", "--platform", "slack");

      await expect(cli.run("bot", "remove", "garden", "--platform", "telegram")).rejects.toThrow(
        /bound to me\/garden/,
      );
      await cli.run("bot", "unbind", "garden");
      await cli.run("bot", "remove", "garden", "--platform", "telegram");

      expect(cli.store.names().filter((name) => name.includes("/garden/"))).toEqual([]);
    });
  });
});

describe("bot list", () => {
  it("says so when no bots exist", async () => {
    const cli = createCliHarness();
    await cli.run("bot", "list");
    expect(cli.output.at(-1)).toBe("No bots registered.");
  });

  it("lists bots sorted by name with connections, binding and token status, never values", async () => {
    const cli = createCliHarness({
      token: "secret-token",
      "signing-secret": "s",
      "github-token": "ghp_x",
    });
    await cli.run("bot", "add", "notes", "--platform", "slack");
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await cli.run("bot", "add", "garden", "--platform", "slack");
    await cli.run("bot", "add", "garden-2", "--platform", "telegram");
    await cli.bind("garden", "me/garden");
    await cli.store.delete(["/centaur/bots/garden-2/platforms/telegram/token"]);
    await cli.run("bot", "list");
    expect(cli.output.at(-1)).toBe(
      [
        "garden  repo=me/garden  slack:token=set  telegram:token=set",
        "garden-2  repo=-  telegram:token=unset",
        "notes  repo=-  slack:token=set",
        "github-token=unset",
      ].join("\n"),
    );

    await cli.run("github-token", "set");
    await cli.run("bot", "list");
    expect(cli.output.at(-1)).toMatch(/github-token=set$/);
    expect(cli.output.join("\n")).not.toContain("secret-token");
  });

  it("shows a bot that has no connection", async () => {
    const cli = createCliHarness();
    await cli.bind("garden", "me/garden");
    await cli.run("bot", "list");
    expect(cli.output.at(-1)).toBe("garden  repo=me/garden  -\ngithub-token=unset");
  });
});

describe("removed user commands", () => {
  it.each([
    ["user", "add", "spouse", "--telegram", "1"],
    ["user", "list"],
  ])("rejects %j", async (...args) => {
    await expect(createCliHarness().run(...args)).rejects.toThrow(/unknown command 'user'/);
  });
});

describe("removed chat add", () => {
  it("is not a command", async () => {
    await expect(createCliHarness().run("chat", "add", "household", "-1")).rejects.toThrow(
      /unknown command 'add'/,
    );
  });
});

describe("github-token", () => {
  it("stores the token as a secure parameter without printing it", async () => {
    const cli = createCliHarness({ "github-token": "ghp_secret" });
    await cli.run("github-token", "set");
    expect(cli.store.entries.get("/centaur/github/token")).toEqual({
      value: "ghp_secret",
      secure: true,
    });
    expect(cli.output.join("\n")).not.toContain("ghp_secret");
  });

  it("removes the token, and fails when none is stored", async () => {
    const cli = createCliHarness({ "github-token": "ghp_secret" });
    await expect(cli.run("github-token", "remove")).rejects.toThrow(/No GitHub token/);
    await cli.run("github-token", "set");
    await cli.run("github-token", "remove");
    expect(cli.store.names()).toEqual([]);
  });
});

describe("chat list", () => {
  it("lists chat aliases sorted by name", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");
    await cli.run("chat", "list", "garden");
    expect(cli.output.at(-1)).toBe("No chats registered.");

    await cli.store.put("/centaur/chats/telegram/workshop", "-2", { secure: false });
    await cli.store.put("/centaur/chats/telegram/household", "-1", { secure: false });
    await cli.run("chat", "list", "garden");

    expect(cli.output.at(-1)).toBe("household  -1\nworkshop  -2");
  });

  it("lists the aliases of the chosen connection only, ignoring the flat form", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");
    await cli.connect("garden", "slack");
    await cli.store.put("/centaur/chats/telegram/household", "-1", { secure: false });
    await cli.store.put("/centaur/chats/slack/household", "C1", { secure: false });
    await cli.store.put("/centaur/chats/legacy", "-9", { secure: false });

    await cli.run("chat", "list", "garden", "--platform", "slack");
    expect(cli.output.at(-1)).toBe("household  C1");
    await cli.run("chat", "list", "garden", "--platform", "telegram");
    expect(cli.output.at(-1)).toBe("household  -1");
  });

  it("asks for --platform with several connections and rejects an unknown bot", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");
    await cli.connect("garden", "slack");

    await expect(cli.run("chat", "list", "garden")).rejects.toThrow(
      /several connections \(telegram, slack\); pass --platform/,
    );
    await expect(cli.run("chat", "list", "missing")).rejects.toThrow(/Unknown bot "missing"/);
  });
});
