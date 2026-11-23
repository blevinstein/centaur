import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";

const TOKEN_PARAMETER = "/centaur/bots/garden/platforms/telegram/token";
const approvedChat = (id: string) => `/centaur/bots/garden/platforms/telegram/approved-chats/${id}`;

async function harnessWithBot() {
  const cli = createCliHarness();
  await cli.connect("garden", "telegram");
  return cli;
}

describe("admin", () => {
  it("sets, shows and removes the admin per platform", async () => {
    const cli = createCliHarness();

    await cli.run("admin", "set", "--telegram", "5001", "--slack", "U5");
    expect(cli.store.entries.get("/centaur/admin/telegram")).toEqual({
      value: "5001",
      secure: false,
    });
    await cli.run("admin", "show");
    expect(cli.output.at(-1)).toBe("telegram: 5001\nslack: U5");

    await cli.run("admin", "remove", "--telegram");
    await cli.run("admin", "show");
    expect(cli.output.at(-1)).toBe("telegram: not set\nslack: U5");
  });

  it.each([
    [["admin", "set"], /at least one/],
    [["admin", "remove"], /at least one/],
    [["admin", "remove", "--slack"], /No admin is set for slack/],
  ])("rejects %j", async (args, message) => {
    await expect(createCliHarness().run(...args)).rejects.toThrow(message);
  });
});

describe("access", () => {
  it.each(["chat", "user"])("approves, lists and revokes a %s", async (kind) => {
    const cli = await harnessWithBot();

    await cli.run("access", "approve", "garden", kind, "42", "--name", "Garden Club");
    const stored = JSON.parse(
      (await cli.store.get(`/centaur/bots/garden/platforms/telegram/approved-${kind}s/42`)) ?? "",
    );
    expect(stored).toMatchObject({ name: "Garden Club" });
    await cli.run("access", "list", "garden");
    expect(cli.output.at(-1)).toMatch(new RegExp(`^approved  ${kind}  42  Garden Club  \\d{4}-`));

    await cli.run("access", "revoke", "garden", kind, "42");
    expect(
      await cli.store.get(`/centaur/bots/garden/platforms/telegram/approved-${kind}s/42`),
    ).toBeUndefined();
  });

  it("blocks by removing the approval, and unblocking does not restore it", async () => {
    const cli = await harnessWithBot();
    await cli.run("access", "approve", "garden", "user", "42");

    await cli.run("access", "block", "garden", "user", "42");
    expect(
      await cli.store.get("/centaur/bots/garden/platforms/telegram/approved-users/42"),
    ).toBeUndefined();
    await cli.run("access", "list", "garden");
    expect(cli.output.at(-1)).toMatch(/^blocked {2}user {2}42/);

    await cli.run("access", "unblock", "garden", "user", "42");
    expect(cli.store.names()).toEqual([TOKEN_PARAMETER]);
  });

  it("refuses to block the platform admin", async () => {
    const cli = await harnessWithBot();
    await cli.run("admin", "set", "--telegram", "5001");

    await expect(cli.run("access", "block", "garden", "user", "5001")).rejects.toThrow(
      /Cannot block 5001: they are the admin for telegram/,
    );
    expect(cli.store.names()).not.toContain(
      "/centaur/bots/garden/platforms/telegram/blocked/user/5001",
    );

    await cli.run("access", "block", "garden", "chat", "5001");
    await cli.run("access", "block", "garden", "user", "5002");
    expect(cli.store.names()).toContain(
      "/centaur/bots/garden/platforms/telegram/blocked/chat/5001",
    );
    expect(cli.store.names()).toContain(
      "/centaur/bots/garden/platforms/telegram/blocked/user/5002",
    );
  });

  it("blocks a subject that was never approved", async () => {
    const cli = await harnessWithBot();
    await cli.run("access", "block", "garden", "chat", "-1");
    expect(
      await cli.store.get("/centaur/bots/garden/platforms/telegram/blocked/chat/-1"),
    ).toBeDefined();
  });

  it("says when nothing is approved or blocked", async () => {
    const cli = await harnessWithBot();
    await cli.run("access", "list", "garden");
    expect(cli.output.at(-1)).toBe('Nothing approved or blocked for "garden".');
  });

  it.each([
    [["access", "approve", "ghost", "chat", "1"], /Unknown bot "ghost"/],
    [["access", "approve", "garden", "room", "1"], /Unknown kind "room"/],
    [["access", "revoke", "garden", "chat", "1"], /Approved chat 1 not found/],
    [["access", "unblock", "garden", "user", "1"], /Blocked user 1 not found/],
  ])("rejects %j", async (args, message) => {
    const cli = await harnessWithBot();
    await expect(cli.run(...args)).rejects.toThrow(message);
  });
});

describe("chat aliases on approval", () => {
  const ALIAS = "/centaur/chats/telegram/garden-club";

  it("creates an alias from the name and records it on the approval", async () => {
    const cli = await harnessWithBot();

    await cli.run("access", "approve", "garden", "chat", "-100500", "--name", "Garden Club");

    expect(cli.output.at(-1)).toBe('Approved chat -100500 for bot "garden" as "garden-club".');
    expect(await cli.store.get(ALIAS)).toBe("-100500");
    expect(JSON.parse((await cli.store.get(approvedChat("-100500"))) ?? "")).toMatchObject({
      alias: "garden-club",
    });
    await cli.run("access", "list", "garden");
    expect(cli.output.at(-1)).toMatch(/Garden Club {2}\d{4}-.* {2}alias=garden-club$/);
  });

  it("uses an explicit alias", async () => {
    const cli = await harnessWithBot();

    await cli.run("access", "approve", "garden", "chat", "-100500", "--alias", "household");

    expect(await cli.store.get("/centaur/chats/telegram/household")).toBe("-100500");
  });

  it.each([
    ["without a name", [], "chat-0500"],
    ["from a name that has no letters or digits", ["--name", "!!!"], "chat-0500"],
  ])("falls back to the last digits of the chat ID %s", async (_name, flags, alias) => {
    const cli = await harnessWithBot();

    await cli.run("access", "approve", "garden", "chat", "-100500", ...flags);

    expect(await cli.store.get(`/centaur/chats/telegram/${alias}`)).toBe("-100500");
  });

  it("adds a numeric suffix when the derived alias names another chat", async () => {
    const cli = await harnessWithBot();
    await cli.store.put("/centaur/chats/telegram/garden-club", "-1", { secure: false });
    await cli.run("access", "approve", "garden", "chat", "-100500", "--name", "Garden Club");

    expect(await cli.store.get("/centaur/chats/telegram/garden-club-2")).toBe("-100500");
    expect(await cli.store.get(ALIAS)).toBe("-1");
  });

  it("reuses the alias that already names the chat", async () => {
    const cli = await harnessWithBot();
    await cli.store.put("/centaur/chats/telegram/household", "-100500", { secure: false });

    await cli.run("access", "approve", "garden", "chat", "-100500", "--name", "Garden Club");

    expect(cli.store.names().filter((name) => name.startsWith("/centaur/chats/"))).toEqual([
      "/centaur/chats/telegram/household",
    ]);
  });

  it("scopes aliases to the connection, so each platform reuses a name", async () => {
    const cli = await harnessWithBot();
    await cli.connect("garden", "slack");
    await cli.store.put("/centaur/chats/telegram/household", "-1", { secure: false });

    await cli.run(
      "access",
      "approve",
      "garden",
      "chat",
      "C0123",
      "--platform",
      "slack",
      "--alias",
      "household",
    );

    expect(await cli.store.get("/centaur/chats/slack/household")).toBe("C0123");
    expect(await cli.store.get("/centaur/chats/telegram/household")).toBe("-1");
  });

  it("does not read a flat alias when deriving or checking a name", async () => {
    const cli = await harnessWithBot();
    await cli.store.put("/centaur/chats/household", "-1", { secure: false });

    await cli.run("access", "approve", "garden", "chat", "-100500", "--alias", "household");

    expect(await cli.store.get("/centaur/chats/telegram/household")).toBe("-100500");
    expect(await cli.store.get("/centaur/chats/household")).toBe("-1");
  });

  it("asks for --platform when approving on a bot with several connections", async () => {
    const cli = await harnessWithBot();
    await cli.connect("garden", "slack");

    await expect(cli.run("access", "approve", "garden", "chat", "-100500")).rejects.toThrow(
      /several connections \(telegram, slack\); pass --platform/,
    );
  });

  it("refuses an explicit alias that names another chat, changing nothing", async () => {
    const cli = await harnessWithBot();
    await cli.store.put("/centaur/chats/telegram/household", "-1", { secure: false });

    await expect(
      cli.run("access", "approve", "garden", "chat", "-100500", "--alias", "household"),
    ).rejects.toThrow(/Alias "household" already names chat -1/);
    expect(await cli.store.get("/centaur/chats/telegram/household")).toBe("-1");
    expect(await cli.store.get(approvedChat("-100500"))).toBeUndefined();
  });

  it.each(["foo_bar", "foo-bar", "a1"])("accepts the alias %s", async (name) => {
    const cli = await harnessWithBot();
    await cli.run("access", "approve", "garden", "chat", "-100500", "--alias", name);
    expect(await cli.store.get(`/centaur/chats/telegram/${name}`)).toBe("-100500");
  });

  it.each(["Bad Alias", "_foo", "-foo", "foo.bar", "Foo"])("rejects the alias %j", async (name) => {
    const cli = await harnessWithBot();
    await expect(
      cli.run("access", "approve", "garden", "chat", "1", "--alias", name),
    ).rejects.toThrow(/Invalid alias name/);
  });

  it("refuses an alias for a user and an invalid alias", async () => {
    const cli = await harnessWithBot();

    await expect(
      cli.run("access", "approve", "garden", "user", "42", "--alias", "pat"),
    ).rejects.toThrow(/--alias applies to chats only/);
  });

  it("renames a chat by approving it again with a new alias, keeping its name", async () => {
    const cli = await harnessWithBot();
    await cli.run("access", "approve", "garden", "chat", "-100500", "--name", "Garden Club");

    await cli.run("access", "approve", "garden", "chat", "-100500", "--alias", "household");

    expect(await cli.store.get("/centaur/chats/telegram/household")).toBe("-100500");
    expect(JSON.parse((await cli.store.get(approvedChat("-100500"))) ?? "")).toMatchObject({
      name: "Garden Club",
      alias: "household",
    });
  });

  it("keeps the alias when the approval is revoked", async () => {
    const cli = await harnessWithBot();
    await cli.run("access", "approve", "garden", "chat", "-100500", "--name", "Garden Club");

    await cli.run("access", "revoke", "garden", "chat", "-100500");

    expect(await cli.store.get(ALIAS)).toBe("-100500");
  });
});

describe("access with several connections", () => {
  const approvedUser = (platform: string, id: string) =>
    `/centaur/bots/garden/platforms/${platform}/approved-users/${id}`;

  async function harnessWithTwoConnections() {
    const cli = await harnessWithBot();
    await cli.connect("garden", "slack");
    return cli;
  }

  it("acts on the connection named by --platform and leaves the other alone", async () => {
    const cli = await harnessWithTwoConnections();

    await cli.run("access", "approve", "garden", "user", "U1", "--platform", "slack");
    expect(await cli.store.get(approvedUser("slack", "U1"))).toBeDefined();
    expect(await cli.store.get(approvedUser("telegram", "U1"))).toBeUndefined();

    await cli.run("access", "list", "garden", "--platform", "telegram");
    expect(cli.output.at(-1)).toBe('Nothing approved or blocked for "garden".');
    await cli.run("access", "list", "garden", "--platform", "slack");
    expect(cli.output.at(-1)).toMatch(/^approved {2}user {2}U1/);

    await cli.run("access", "block", "garden", "user", "U1", "--platform", "slack");
    await cli.run("access", "unblock", "garden", "user", "U1", "--platform", "slack");
    await cli.run("access", "approve", "garden", "user", "U1", "--platform", "slack");
    await cli.run("access", "revoke", "garden", "user", "U1", "--platform", "slack");
    expect(cli.store.names().filter((name) => name.includes("U1"))).toEqual([]);
  });

  it.each([
    ["approve", ["user", "1"]],
    ["revoke", ["user", "1"]],
    ["block", ["user", "1"]],
    ["unblock", ["user", "1"]],
    ["list", []],
  ])("%s requires --platform", async (command, rest) => {
    const cli = await harnessWithTwoConnections();
    const before = cli.store.names();
    await expect(cli.run("access", command, "garden", ...rest)).rejects.toThrow(
      /several connections \(telegram, slack\); pass --platform/,
    );
    expect(cli.store.names()).toEqual(before);
  });

  it("refuses a platform the bot is not on", async () => {
    const cli = await harnessWithBot();
    await expect(
      cli.run("access", "approve", "garden", "user", "1", "--platform", "slack"),
    ).rejects.toThrow(/no slack connection/);
  });

  it("blocks the admin of the connection's platform only", async () => {
    const cli = await harnessWithTwoConnections();
    await cli.run("admin", "set", "--slack", "U5");

    await cli.run("access", "block", "garden", "user", "U5", "--platform", "telegram");
    await expect(
      cli.run("access", "block", "garden", "user", "U5", "--platform", "slack"),
    ).rejects.toThrow(/they are the admin for slack/);
  });
});
