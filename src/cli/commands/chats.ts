import type { Command } from "commander";
import { subjectIdOf } from "../../lambda/access-entries.js";
import { knownChatAliases } from "../chat-aliases.js";
import type { CliContext } from "../context.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { requireConnection } from "../registry.js";

export function registerChatCommands(program: Command, context: CliContext): void {
  const chat = program
    .command("chat")
    .description("Inspect chat aliases (approving a chat creates one)");

  withPlatformOption(chat.command("list <bot>"))
    .description("List a connection's chat aliases and their IDs")
    .action(async (bot: string, { platform: requested }: PlatformOptions) => {
      const platform = await requireConnection(context.store, bot, requested);
      const lines = Object.entries(await knownChatAliases(context.store, platform))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, id]) => `${subjectIdOf(name)}  ${id}`);
      context.log(lines.length === 0 ? "No chats registered." : lines.join("\n"));
    });
}
