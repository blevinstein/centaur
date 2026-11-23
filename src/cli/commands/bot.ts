import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import {
  botPath,
  connectionParameter,
  connectionPath,
  repoParameter,
} from "../../lambda/connection-paths.js";
import type { CliContext } from "../context.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import {
  CliError,
  GITHUB_TOKEN_PARAMETER,
  listBotConnections,
  PLATFORM_SECRETS,
  parseName,
  parsePlatform,
  selectConnection,
} from "../registry.js";

const WEBHOOK_SECRET_BYTES = 32;

async function boundRepo(context: CliContext, bot: string): Promise<string | undefined> {
  return context.store.get(repoParameter(bot));
}

export function registerBotCommands(program: Command, context: CliContext): void {
  const bot = program.command("bot").description("Manage bots and their secrets");

  bot
    .command("add <bot>")
    .requiredOption("--platform <platform>", "telegram or slack")
    .description(
      "Store a bot's secrets for one platform in SSM (read from env, stdin, or a hidden prompt)",
    )
    .action(async (name: string, options: { platform: string }) => {
      parseName("bot", name);
      const platform = parsePlatform(options.platform);
      const existing = (await listBotConnections(context.store, name)).get(name);
      if (existing?.has(platform)) {
        throw new CliError(`Bot "${name}" already has a ${platform} connection; remove it first.`);
      }
      const { prompted, generated } = PLATFORM_SECRETS[platform];
      const secrets = await context.readSecrets(prompted);
      for (const key of generated) {
        secrets[key] = randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url");
      }
      for (const [key, value] of Object.entries(secrets)) {
        await context.store.put(connectionParameter(name, platform, key), value, { secure: true });
      }
      context.log(`Added ${platform} connection to bot "${name}".`);
    });

  bot
    .command("list")
    .description("List bots with their connections, bound repo, and whether secrets are set")
    .action(async () => {
      const bots = await listBotConnections(context.store);
      if (bots.size === 0) {
        context.log("No bots registered.");
        return;
      }
      const lines = await Promise.all(
        [...bots.keys()].sort().map(async (name) => {
          const repo = await boundRepo(context, name);
          const connections = [...(bots.get(name) ?? [])]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([platform, keys]) => `${platform}:token=${keys.has("token") ? "set" : "unset"}`);
          return [
            name,
            `repo=${repo ?? "-"}`,
            ...(connections.length > 0 ? connections : ["-"]),
          ].join("  ");
        }),
      );
      const githubToken = (await context.store.get(GITHUB_TOKEN_PARAMETER)) ? "set" : "unset";
      context.log([...lines, `github-token=${githubToken}`].join("\n"));
    });

  withPlatformOption(bot.command("remove <bot>"))
    .description(
      "Delete one connection's secrets, or the whole bot when it has no other connection",
    )
    .action(async (name: string, options: PlatformOptions) => {
      const connections = (await listBotConnections(context.store, name)).get(name);
      if (!connections) throw new CliError(`Unknown bot "${name}".`);
      const platform =
        connections.size === 0
          ? undefined
          : selectConnection(name, connections.keys(), options.platform);
      if (platform === undefined || connections.size === 1) {
        const repo = await boundRepo(context, name);
        if (repo) {
          throw new CliError(`Bot "${name}" is bound to ${repo}; run "centaur bot unbind" first.`);
        }
        await context.store.delete(await context.store.listNames(`${botPath(name)}/`));
        context.log(`Removed bot "${name}".`);
        return;
      }
      await context.store.delete(
        await context.store.listNames(`${connectionPath(name, platform)}/`),
      );
      context.log(`Removed the ${platform} connection from bot "${name}".`);
    });

  bot
    .command("unbind <bot>")
    .description("Release a bot from the repo that registered it")
    .action(async (name: string) => {
      if (!(await listBotConnections(context.store, name)).has(name)) {
        throw new CliError(`Unknown bot "${name}".`);
      }
      const repo = await boundRepo(context, name);
      if (!repo) throw new CliError(`Bot "${name}" is not bound to a repo.`);
      await context.store.delete([repoParameter(name)]);
      context.log(`Unbound bot "${name}" from ${repo}.`);
    });
}
