import type { Command } from "commander";
import { subjectIdOf } from "../../lambda/access-entries.js";
import type { CliContext } from "../context.js";
import { knownDestinations } from "../destinations.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { requireConnection } from "../registry.js";

export function registerChatCommands(program: Command, context: CliContext): void {
  const chat = program
    .command("chat")
    .description("Inspect a connection's destinations (approving a chat creates one)");

  withPlatformOption(chat.command("list <bot>"))
    .description("List a connection's destinations and their chat IDs")
    .action(async (bot: string, { platform: requested }: PlatformOptions) => {
      const platform = await requireConnection(context.store, bot, requested);
      const lines = Object.entries(await knownDestinations(context.store, platform))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { chatId }]) => `${subjectIdOf(name)}  ${chatId}`);
      context.log(lines.length === 0 ? "No chats registered." : lines.join("\n"));
    });
}
