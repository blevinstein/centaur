import { describe, expect, it, vi } from "vitest";
import { telegramAdminChannel } from "../src/lambda/admin-channel.js";
import { registerAdminHandlers } from "../src/lambda/admin-handlers.js";

const wire = (commands: boolean) => {
  const decisions = {
    fromReaction: vi.fn(async () => {}),
    fromCommand: vi.fn(async () => "done" as string | undefined),
  };
  const chat = { onReaction: vi.fn(), onSlashCommand: vi.fn(), processMessage: vi.fn() };
  const claimAdmin = vi.fn(async () => "claimed" as string | undefined);
  const approverCommand = vi.fn(async () => "approver reply" as string | undefined);
  registerAdminHandlers(
    chat,
    { ...telegramAdminChannel, commands },
    decisions,
    claimAdmin,
    approverCommand,
  );
  return { chat, decisions, claimAdmin, approverCommand };
};

describe("admin handlers", () => {
  it("routes reactions and slash commands to the decisions and replies in the channel", async () => {
    const { chat, decisions } = wire(true);
    const reaction = { rawEmoji: "👍" };
    await chat.onReaction.mock.calls[0]?.[0](reaction);
    expect(decisions.fromReaction).toHaveBeenCalledWith(reaction);

    const [commands, handler] = chat.onSlashCommand.mock.calls[0] ?? [];
    expect(commands).toEqual(["/approve", "/deny"]);
    const post = vi.fn();
    await handler({
      command: "/approve",
      text: "abc",
      user: { userId: "1" },
      adapter: { isDM: () => true },
      channel: { id: "telegram:1", post },
    });
    expect(decisions.fromCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/approve", isDM: true }),
    );
    expect(post).toHaveBeenCalledWith("done");
  });

  it("stays silent when a command is not for this admin", async () => {
    const { chat, decisions } = wire(true);
    decisions.fromCommand.mockResolvedValue(undefined);
    const post = vi.fn();

    await chat.onSlashCommand.mock.calls[0]?.[1]({
      command: "/approve",
      text: "",
      user: { userId: "2" },
      adapter: {},
      channel: { id: "x", post },
    });

    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["/start", "abc-123 trailing", "abc-123"],
    ["/claim", "  abc-123", "abc-123"],
  ])("passes the code of %s to the claimer and replies", async (command, text, code) => {
    const { chat, claimAdmin } = wire(true);
    const [commands, handler] = chat.onSlashCommand.mock.calls[1] ?? [];
    expect(commands).toEqual(["/start", "/claim"]);
    const post = vi.fn();

    await handler({
      command,
      text,
      user: { userId: "7" },
      adapter: { isDM: () => true },
      channel: { id: "telegram:7", post },
    });

    expect(claimAdmin).toHaveBeenCalledWith({ userId: "7", isDM: true, code });
    expect(post).toHaveBeenCalledWith("claimed");
    expect(chat.processMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["has no code", "", "claimed"],
    ["is not a live claim", "abc", undefined],
  ])("processes the message normally when a claim command %s", async (_name, text, reply) => {
    const { chat, claimAdmin } = wire(true);
    claimAdmin.mockResolvedValue(reply);
    const post = vi.fn();
    const parsed = { id: "m1" };
    const adapter = { isDM: () => true, parseMessage: vi.fn(() => parsed) };

    await chat.onSlashCommand.mock.calls[1]?.[1]({
      command: "/start",
      text,
      user: { userId: "7" },
      adapter,
      raw: { raw: true },
      channel: { id: "telegram:7", post },
    });

    expect(post).not.toHaveBeenCalled();
    expect(adapter.parseMessage).toHaveBeenCalledWith({ raw: true });
    expect(chat.processMessage).toHaveBeenCalledWith(adapter, "telegram:7", parsed);
  });

  it.each([
    ["answers", "request", "approver reply", true],
    ["processes the message normally for an unknown subcommand in", "add 5", undefined, false],
  ])("%s /approver", async (_name, text, reply, answered) => {
    const { chat, approverCommand } = wire(true);
    const post = vi.fn();
    const adapter = { isDM: () => true, parseMessage: vi.fn(() => ({})) };

    await chat.onSlashCommand.mock.calls[2]?.[1]({
      command: "/approver",
      text,
      user: { userId: "7", fullName: "Pat" },
      adapter,
      raw: {},
      channel: { id: "telegram:7", post },
    });

    expect(approverCommand).toHaveBeenCalledTimes(answered ? 1 : 0);
    expect(post.mock.calls).toEqual(answered ? [[reply]] : []);
    expect(chat.processMessage).toHaveBeenCalledTimes(answered ? 0 : 1);
  });

  it("registers no slash commands on a channel without them", () => {
    expect(wire(false).chat.onSlashCommand).not.toHaveBeenCalled();
  });
});
