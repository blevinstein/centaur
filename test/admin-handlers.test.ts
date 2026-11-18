import { describe, expect, it, vi } from "vitest";
import { telegramAdminChannel } from "../src/lambda/admin-channel.js";
import { registerAdminHandlers } from "../src/lambda/admin-handlers.js";

const wire = (commands: boolean) => {
  const decisions = {
    fromReaction: vi.fn(async () => {}),
    fromCommand: vi.fn(async () => "done" as string | undefined),
  };
  const chat = { onReaction: vi.fn(), onSlashCommand: vi.fn() };
  const claimAdmin = vi.fn(async () => "claimed" as string | undefined);
  registerAdminHandlers(chat, { ...telegramAdminChannel, commands }, decisions, claimAdmin);
  return { chat, decisions, claimAdmin };
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
  });

  it.each([
    ["has no code", "", "claimed"],
    ["is ignored by the claimer", "abc", undefined],
  ])("stays silent when a claim command %s", async (_name, text, reply) => {
    const { chat, claimAdmin } = wire(true);
    claimAdmin.mockResolvedValue(reply);
    const post = vi.fn();

    await chat.onSlashCommand.mock.calls[1]?.[1]({
      command: "/start",
      text,
      user: { userId: "7" },
      adapter: {},
      channel: { id: "x", post },
    });

    expect(post).not.toHaveBeenCalled();
  });

  it("registers no slash commands on a channel without them", () => {
    expect(wire(false).chat.onSlashCommand).not.toHaveBeenCalled();
  });
});
