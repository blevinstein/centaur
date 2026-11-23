import type { Command } from "commander";
import { buildThreadId } from "../../config/index.js";
import { subjectIdOf } from "../../lambda/access-entries.js";
import {
  approvedParameter,
  blockedParameter,
  scopedChatParameter,
} from "../../lambda/connection-paths.js";
import { encodeDestination, parseDestination } from "../../lambda/destinations.js";
import type { CliContext } from "../context.js";
import { knownDestinations } from "../destinations.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { CliError, parseName, requireConnection } from "../registry.js";

interface SetOptions extends PlatformOptions {
  chat: string;
  topic?: string;
}

export function registerDestinationCommands(program: Command, context: CliContext): void {
  const destination = program
    .command("destination")
    .description("Name the chats and topics a bot's prompts post to");

  withPlatformOption(destination.command("set <bot> <name>"))
    .description("Bind a name to a chat, or to an existing topic or thread of it")
    .requiredOption("--chat <id>", "the chat or channel ID")
    .option("--topic <id>", "the topic ID (Telegram) or thread timestamp (Slack) to bind")
    .action(async (bot: string, name: string, options: SetOptions) => {
      const platform = await requireConnection(context.store, bot, options.platform);
      parseName("destination", name);
      const parameter = scopedChatParameter(platform, name);
      const stored = await context.store.get(parameter);
      const existing = stored === undefined ? undefined : parseDestination(stored);
      if (existing?.bot !== undefined && existing.bot !== bot) {
        throw new CliError(
          `Destination "${name}" on ${platform} is bound to a thread owned by bot "${existing.bot}".`,
        );
      }
      const fields =
        options.topic === undefined
          ? { chatId: options.chat }
          : {
              chatId: options.chat,
              threadId: buildThreadId(platform, options.chat, options.topic),
              bot,
            };
      await context.store.put(parameter, encodeDestination(fields), { secure: false });

      const hasEntry = async (build: typeof approvedParameter) =>
        (await context.store.get(build(bot, platform, "chat", options.chat))) !== undefined;
      if (await hasEntry(blockedParameter)) {
        context.log(
          `Warning: chat ${options.chat} is blocked for bot "${bot}"; the poster refuses it until it is unblocked and approved.`,
        );
      } else if (!(await hasEntry(approvedParameter))) {
        context.log(
          `Warning: chat ${options.chat} is not approved for bot "${bot}" on ${platform}; the poster refuses it until you run \`centaur access approve ${bot} chat ${options.chat} --platform ${platform}\`.`,
        );
      }
      const replaced = existing
        ? `, replacing ${existing.threadId ?? `chat ${existing.chatId}`}`
        : "";
      context.log(
        `Destination "${name}" on ${platform} now ${fields.chatId}${"threadId" in fields ? ` (${fields.threadId})` : ""}${replaced}.`,
      );
    });

  withPlatformOption(destination.command("list <bot>"))
    .description("List a connection's destinations")
    .action(async (bot: string, { platform: requested }: PlatformOptions) => {
      const platform = await requireConnection(context.store, bot, requested);
      const lines = Object.entries(await knownDestinations(context.store, platform))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { chatId, threadId }]) =>
          [subjectIdOf(name), chatId, ...(threadId ? [threadId] : [])].join("  "),
        );
      context.log(
        lines.length === 0 ? `No destinations for bot "${bot}" on ${platform}.` : lines.join("\n"),
      );
    });

  withPlatformOption(destination.command("remove <bot> <name>"))
    .description("Delete a destination")
    .action(async (bot: string, name: string, { platform: requested }: PlatformOptions) => {
      const platform = await requireConnection(context.store, bot, requested);
      const parameter = scopedChatParameter(platform, name);
      if ((await context.store.get(parameter)) === undefined) {
        throw new CliError(`Destination "${name}" not found on ${platform}.`);
      }
      await context.store.delete([parameter]);
      context.log(`Removed destination "${name}" on ${platform}.`);
    });
}
