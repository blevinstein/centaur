import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { CliError, chatParameter, PLATFORM_NAMES, parseName, userParameter } from "../registry.js";

export function registerAllowlistCommands(program: Command, context: CliContext): void {
  const user = program.command("user").description("Manage allowlisted users");
  const addUser = user
    .command("add <name>")
    .description("Record a user's platform IDs (stored by name, referenced from .centaur.yml)");
  for (const platform of PLATFORM_NAMES) {
    addUser.option(`--${platform} <id>`, `${platform} user ID`);
  }
  addUser.action(async (name: string, options: Record<string, string | undefined>) => {
    parseName("user", name);
    const ids = PLATFORM_NAMES.flatMap((platform) => {
      const id = options[platform];
      return id ? [{ platform, id }] : [];
    });
    if (ids.length === 0) {
      throw new CliError(`Pass at least one of ${PLATFORM_NAMES.map((p) => `--${p}`).join(", ")}.`);
    }
    for (const { platform, id } of ids) {
      await context.store.put(userParameter(name, platform), id, { secure: false });
    }
    context.log(`Recorded ${ids.map(({ platform }) => platform).join(", ")} for user "${name}".`);
  });

  program
    .command("chat")
    .description("Manage named chats")
    .command("add <name> <id>")
    .description("Record a chat ID under a name (e.g. household)")
    .action(async (name: string, id: string) => {
      parseName("chat", name);
      await context.store.put(chatParameter(name), id, { secure: false });
      context.log(`Recorded chat "${name}".`);
    });
}
