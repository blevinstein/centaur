import type { Command } from "commander";
import { subjectIdOf } from "../../lambda/access-entries.js";
import { knownChatAliases } from "../chat-aliases.js";
import type { CliContext } from "../context.js";

export function registerChatCommands(program: Command, context: CliContext): void {
  const chat = program
    .command("chat")
    .description("Inspect chat aliases (approving a chat creates one)");

  chat
    .command("list")
    .description("List chat aliases and their IDs")
    .action(async () => {
      const lines = Object.entries(await knownChatAliases(context.store))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, id]) => `${subjectIdOf(name)}  ${id}`);
      context.log(lines.length === 0 ? "No chats registered." : lines.join("\n"));
    });
}
