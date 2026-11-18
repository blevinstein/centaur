import { describe, expect, it, vi } from "vitest";
import { decodeClaim, hashClaimCode } from "../src/lambda/admin-claim-record.js";
import { createTelegramApi } from "../src/lambda/telegram.js";
import { createCliHarness } from "./helpers/cli.js";

const TOKEN = "123456:secret-bot-token";
const CLAIM = "/centaur/admin-claim/telegram";

async function harness(telegram?: Parameters<typeof createCliHarness>[1]) {
  const cli = createCliHarness({}, telegram);
  await cli.store.put("/centaur/bots/garden/platform", "telegram", { secure: false });
  await cli.store.put("/centaur/bots/garden/token", TOKEN, { secure: true });
  await cli.store.put("/centaur/bots/notes/platform", "slack", { secure: false });
  return cli;
}

const printedCode = (cli: { output: string[] }, pattern: RegExp) =>
  pattern.exec(cli.output.join("\n"))?.[1] as string;

describe("admin claim", () => {
  it("prints a Telegram deep link and stores only the hash, expiry and bot", async () => {
    const cli = await harness();

    await cli.run("admin", "claim", "garden");

    const code = printedCode(cli, /start=([\w-]+)/);
    expect(cli.output.join("\n")).toContain(`https://t.me/garden_bot?start=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const stored = cli.store.entries.get(CLAIM);
    expect(stored?.value).not.toContain(code);
    expect(decodeClaim(stored?.value)).toEqual({
      bot: "garden",
      hash: hashClaimCode(code),
      expiresAt: expect.any(String),
    });
    const minutes = (Date.parse(decodeClaim(stored?.value)?.expiresAt ?? "") - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("honours --ttl-minutes", async () => {
    const cli = await harness();

    await cli.run("admin", "claim", "garden", "--ttl-minutes", "60");

    const minutes =
      (Date.parse(decodeClaim(cli.store.entries.get(CLAIM)?.value)?.expiresAt ?? "") - Date.now()) /
      60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(cli.output.join("\n")).toContain("60 minutes");
  });

  it.each(["0", "abc", "1.5", "99999"])("rejects --ttl-minutes %s", async (value) => {
    const cli = await harness();
    await expect(cli.run("admin", "claim", "garden", "--ttl-minutes", value)).rejects.toThrow(
      /ttl-minutes/,
    );
  });

  it("prints the code and the DM instruction for a Slack bot, without asking Telegram", async () => {
    const getMe = vi.fn();
    const cli = await harness({ getMe });

    await cli.run("admin", "claim", "notes");

    const code = printedCode(cli, /claim ([\w-]+)/);
    expect(getMe).not.toHaveBeenCalled();
    expect(cli.output.join("\n")).toContain(`direct message: claim ${code}`);
    expect(decodeClaim(cli.store.entries.get("/centaur/admin-claim/slack")?.value)?.bot).toBe(
      "notes",
    );
  });

  it("replaces a pending claim", async () => {
    const cli = await harness();
    await cli.run("admin", "claim", "garden");
    const first = cli.store.entries.get(CLAIM)?.value;

    await cli.run("admin", "claim", "garden");

    expect(cli.store.entries.get(CLAIM)?.value).not.toBe(first);
    expect(cli.store.names().filter((name) => name.includes("admin-claim"))).toEqual([CLAIM]);
  });

  it("requires the bot to exist", async () => {
    await expect((await harness()).run("admin", "claim", "ghost")).rejects.toThrow(
      /Unknown bot "ghost"/,
    );
  });

  it("fails clearly, storing nothing and never printing the token, when getMe fails", async () => {
    const response = new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
      status: 401,
    });
    const telegram = createTelegramApi(async () => response);
    const cli = await harness(telegram);

    const failure = await cli.run("admin", "claim", "garden").catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Could not look up the bot's username.*Unauthorized/,
    );
    expect(JSON.stringify([(failure as Error).message, cli.output])).not.toContain(TOKEN);
    expect(cli.store.entries.has(CLAIM)).toBe(false);
  });

  it("never prints the token on success", async () => {
    const cli = await harness();
    await cli.run("admin", "claim", "garden");
    expect(cli.output.join("\n")).not.toContain(TOKEN);
  });

  it("cancels a pending claim for that bot", async () => {
    const cli = await harness();
    await cli.run("admin", "claim", "garden");

    await cli.run("admin", "claim", "garden", "--cancel");

    expect(cli.store.entries.has(CLAIM)).toBe(false);
  });

  it("refuses to cancel when nothing is pending for that bot", async () => {
    const cli = await harness();
    await expect(cli.run("admin", "claim", "garden", "--cancel")).rejects.toThrow(
      /No pending claim/,
    );
    await cli.store.put(
      CLAIM,
      JSON.stringify({ bot: "other", hash: "0".repeat(64), expiresAt: new Date().toISOString() }),
      { secure: false },
    );
    await expect(cli.run("admin", "claim", "garden", "--cancel")).rejects.toThrow(
      /No pending claim/,
    );
    expect(cli.store.entries.has(CLAIM)).toBe(true);
  });
});
