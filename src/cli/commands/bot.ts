import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import {
  botParameter,
  botPrefix,
  CliError,
  PLATFORMS,
  parseName,
  parsePlatform,
  requireBotPlatform,
} from "../registry.js";

const WEBHOOK_SECRET_BYTES = 32;

async function boundRepo(context: CliContext, bot: string): Promise<string | undefined> {
  return context.store.get(botParameter(bot, "repo"));
}

export function registerBotCommands(program: Command, context: CliContext): void {
  const bot = program.command("bot").description("Manage bots and their secrets");

  bot
    .command("add <bot>")
    .requiredOption("--platform <platform>", "telegram or slack")
    .description("Store a bot's secrets in SSM (read from env, stdin, or a hidden prompt)")
    .action(async (name: string, options: { platform: string }) => {
      parseName("bot", name);
      const platform = parsePlatform(options.platform);
      if (await context.store.get(botParameter(name, "platform"))) {
        throw new CliError(`Bot "${name}" already exists; remove it first.`);
      }
      const { prompted, generated } = PLATFORMS[platform];
      const secrets = await context.readSecrets(prompted);
      for (const key of generated) {
        secrets[key] = randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url");
      }
      for (const [key, value] of Object.entries(secrets)) {
        await context.store.put(botParameter(name, key), value, { secure: true });
      }
      await context.store.put(botParameter(name, "platform"), platform, { secure: false });
      context.log(`Added ${platform} bot "${name}".`);
    });

  bot
    .command("remove <bot>")
    .description("Delete a bot's secrets from SSM")
    .action(async (name: string) => {
      await requireBotPlatform(context.store, name);
      const repo = await boundRepo(context, name);
      if (repo) {
        throw new CliError(`Bot "${name}" is bound to ${repo}; run "centaur bot unbind" first.`);
      }
      await context.store.delete(await context.store.listNames(botPrefix(name)));
      context.log(`Removed bot "${name}".`);
    });

  bot
    .command("unbind <bot>")
    .description("Release a bot from the repo that registered it")
    .action(async (name: string) => {
      await requireBotPlatform(context.store, name);
      const repo = await boundRepo(context, name);
      if (!repo) throw new CliError(`Bot "${name}" is not bound to a repo.`);
      await context.store.delete([botParameter(name, "repo")]);
      context.log(`Unbound bot "${name}" from ${repo}.`);
    });
}
