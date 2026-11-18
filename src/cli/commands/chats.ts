import type { Command } from "commander";
import { subjectIdOf } from "../../lambda/access-entries.js";
import { knownChatAliases } from "../chat-aliases.js";
import type { CliContext } from "../context.js";
import { chatParameter, parseName } from "../registry.js";

export function registerChatCommands(program: Command, context: CliContext): void {
  const chat = program
    .command("chat")
    .description("Create or rename chat aliases (approving a chat creates one automatically)");

  chat
    .command("list")
    .description("List chat aliases and their IDs")
    .action(async () => {
      const lines = Object.entries(await knownChatAliases(context.store))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, id]) => `${subjectIdOf(name)}  ${id}`);
      context.log(lines.length === 0 ? "No chats registered." : lines.join("\n"));
    });

  chat
    .command("add <name> <id>")
    .description("Record a chat ID under an alias (e.g. household), replacing any existing value")
    .action(async (name: string, id: string) => {
      parseName("chat", name);
      await context.store.put(chatParameter(name), id, { secure: false });
      context.log(`Recorded chat "${name}".`);
    });
}
