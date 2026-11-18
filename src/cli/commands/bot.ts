import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import {
  BOTS_PREFIX,
  botParameter,
  botPrefix,
  CliError,
  GITHUB_TOKEN_PARAMETER,
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
    .command("list")
    .description("List bots with their platform, bound repo, and whether secrets are set")
    .action(async () => {
      const prefix = BOTS_PREFIX;
      const keysByBot = new Map<string, Set<string>>();
      for (const parameter of await context.store.listNames(prefix)) {
        const [name, ...key] = parameter.slice(prefix.length).split("/");
        if (name && key.length > 0) {
          keysByBot.set(name, (keysByBot.get(name) ?? new Set()).add(key.join("/")));
        }
      }
      if (keysByBot.size === 0) {
        context.log("No bots registered.");
        return;
      }
      const lines = await Promise.all(
        [...keysByBot.keys()].sort().map(async (name) => {
          const platform = await context.store.get(botParameter(name, "platform"));
          const repo = await boundRepo(context, name);
          const token = keysByBot.get(name)?.has("token") ? "set" : "unset";
          return `${name}  ${platform ?? "-"}  repo=${repo ?? "-"}  token=${token}`;
        }),
      );
      const githubToken = (await context.store.get(GITHUB_TOKEN_PARAMETER)) ? "set" : "unset";
      context.log([...lines, `github-token=${githubToken}`].join("\n"));
    });

  bot
    .command("remove <bot>")
    .description("Delete a bot's secrets from SSM")
    .action(async (name: string) => {
      const names = await context.store.listNames(botPrefix(name));
      if (names.length === 0) throw new CliError(`Unknown bot "${name}".`);
      const repo = await boundRepo(context, name);
      if (repo) {
        throw new CliError(`Bot "${name}" is bound to ${repo}; run "centaur bot unbind" first.`);
      }
      await context.store.delete(names);
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
