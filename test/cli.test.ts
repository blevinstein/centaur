import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";

describe("bot add", () => {
  it("stores a telegram token and a generated webhook secret as secure parameters", async () => {
    const cli = createCliHarness({ token: "123:abc" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");

    expect(cli.store.names()).toEqual([
      "/centaur/bots/garden/platform",
      "/centaur/bots/garden/token",
      "/centaur/bots/garden/webhook-secret",
    ]);
    expect(cli.store.entries.get("/centaur/bots/garden/token")).toEqual({
      value: "123:abc",
      secure: true,
    });
    const secret = cli.store.entries.get("/centaur/bots/garden/webhook-secret");
    expect(secret?.secure).toBe(true);
    expect(secret?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cli.output.join("\n")).not.toContain("123:abc");
    expect(cli.output.join("\n")).not.toContain(secret?.value ?? "");
  });

  it("generates a different webhook secret per bot", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "a", "--platform", "telegram");
    await cli.run("bot", "add", "b", "--platform", "telegram");
    expect(cli.store.entries.get("/centaur/bots/a/webhook-secret")?.value).not.toBe(
      cli.store.entries.get("/centaur/bots/b/webhook-secret")?.value,
    );
  });

  it("stores the signing secret for slack and generates nothing", async () => {
    const cli = createCliHarness({ token: "xoxb-1", "signing-secret": "sig" });
    await cli.run("bot", "add", "notes", "--platform", "slack");
    expect(cli.store.names()).toEqual([
      "/centaur/bots/notes/platform",
      "/centaur/bots/notes/signing-secret",
      "/centaur/bots/notes/token",
    ]);
  });

  it.each([
    [["bot", "add", "garden", "--platform", "irc"], /Unknown platform/],
    [["bot", "add", "Bad/Name", "--platform", "telegram"], /Invalid bot name/],
  ])("rejects %j", async (args, message) => {
    const cli = createCliHarness({ token: "t" });
    await expect(cli.run(...args)).rejects.toThrow(message);
    expect(cli.store.names()).toEqual([]);
  });

  it("refuses to overwrite an existing bot", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await expect(cli.run("bot", "add", "garden", "--platform", "telegram")).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("bot remove and unbind", () => {
  async function addBoundBot() {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await cli.run("bot", "add", "other", "--platform", "telegram");
    await cli.store.put("/centaur/bots/garden/repo", "me/garden", { secure: false });
    return cli;
  }

  it("refuses to remove a bound bot, then removes it after unbinding", async () => {
    const cli = await addBoundBot();
    await expect(cli.run("bot", "remove", "garden")).rejects.toThrow(/bound to me\/garden/);

    await cli.run("bot", "unbind", "garden");
    expect(await cli.store.get("/centaur/bots/garden/repo")).toBeUndefined();
    expect(await cli.store.get("/centaur/bots/garden/token")).toBe("t");

    await cli.run("bot", "remove", "garden");
    expect(cli.store.names().filter((name) => name.includes("/garden/"))).toEqual([]);
    expect(cli.store.names()).toContain("/centaur/bots/other/token");
  });

  it("does not match bots whose names share a prefix", async () => {
    const cli = createCliHarness({ token: "t" });
    await cli.run("bot", "add", "garden", "--platform", "telegram");
    await cli.run("bot", "add", "garden-2", "--platform", "telegram");
    await cli.run("bot", "remove", "garden");
    expect(cli.store.names()).toContain("/centaur/bots/garden-2/token");
  });

  it.each([
    ["remove", /Unknown bot/],
    ["unbind", /Unknown bot/],
  ])("%s fails for an unknown bot", async (command, message) => {
    const cli = createCliHarness();
    await expect(cli.run("bot", command, "ghost")).rejects.toThrow(message);
  });

  it("removes orphan parameters left without a platform", async () => {
    const cli = await addBoundBot();
    await cli.store.delete(["/centaur/bots/other/platform"]);
    await cli.run("bot", "remove", "other");
    expect(cli.store.names().filter((name) => name.includes("/other/"))).toEqual([]);
  });

  it("unbind fails for an unbound bot", async () => {
    const cli = await addBoundBot();
    await expect(cli.run("bot", "unbind", "other")).rejects.toThrow(/not bound/);
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

describe("chat add", () => {
  it("records a named chat", async () => {
    const cli = createCliHarness();
    await cli.run("chat", "add", "household", "-1001234");
    expect(await cli.store.get("/centaur/chats/household")).toBe("-1001234");
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

  it("lists chats sorted by name", async () => {
    const cli = createCliHarness();
    await cli.run("chat", "list");
    expect(cli.output.at(-1)).toBe("No chats registered.");

    await cli.run("chat", "add", "workshop", "-2");
    await cli.run("chat", "add", "household", "-1");
    await cli.run("chat", "list");

    expect(cli.output.at(-1)).toBe("household  -1\nworkshop  -2");
  });
});
