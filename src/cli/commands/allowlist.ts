import type { Command } from "commander";
import type { CliContext } from "../context.js";
import {
  chatParameter,
  PLATFORM_NAMES,
  parseName,
  selectedPlatformIds,
  userParameter,
} from "../registry.js";

const USERS_PREFIX = "/centaur/users/";
const CHATS_PREFIX = "/centaur/chats/";

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
    const ids = selectedPlatformIds(options);
    for (const { platform, id } of ids) {
      await context.store.put(userParameter(name, platform), id, { secure: false });
    }
    context.log(`Recorded ${ids.map(({ platform }) => platform).join(", ")} for user "${name}".`);
  });

  user
    .command("list")
    .description("List registered users and their platform IDs")
    .action(async () => {
      const byName = new Map<string, string[]>();
      for (const parameter of await context.store.listNames(USERS_PREFIX)) {
        const [name, platform] = parameter.slice(USERS_PREFIX.length).split("/");
        const id = await context.store.get(parameter);
        if (name && platform && id)
          byName.set(name, [...(byName.get(name) ?? []), `${platform}=${id}`]);
      }
      context.log(
        byName.size === 0
          ? "No users registered."
          : [...byName]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, ids]) => `${name}  ${ids.sort().join("  ")}`)
              .join("\n"),
      );
    });

  const chat = program.command("chat").description("Manage named chats");

  chat
    .command("list")
    .description("List registered chats and their IDs")
    .action(async () => {
      const names = (await context.store.listNames(CHATS_PREFIX)).sort();
      const lines = await Promise.all(
        names.map(
          async (name) => `${name.slice(CHATS_PREFIX.length)}  ${await context.store.get(name)}`,
        ),
      );
      context.log(lines.length === 0 ? "No chats registered." : lines.join("\n"));
    });

  chat
    .command("add <name> <id>")
    .description("Record a chat ID under a name (e.g. household)")
    .action(async (name: string, id: string) => {
      parseName("chat", name);
      await context.store.put(chatParameter(name), id, { secure: false });
      context.log(`Recorded chat "${name}".`);
    });
}
