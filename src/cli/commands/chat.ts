import type { Command } from "commander";
import { STATE_TABLE_PARAMETER } from "../../lambda/parameters.js";
import {
  DEFAULT_LIMIT,
  DEFAULT_MINUTES,
  formatTail,
  MAX_LIMIT,
  parseCount,
  readTail,
  STATE_TABLE_ENV,
} from "../chat-tail.js";
import type { CliContext } from "../context.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { requireConnection } from "../registry.js";

interface TailFlags extends PlatformOptions {
  minutes: string;
  limit: string;
  text?: boolean;
  table?: string;
}

export function registerChatCommands(program: Command, context: CliContext): void {
  const chat = program.command("chat").description("Inspect a bot's recent chat messages");

  withPlatformOption(chat.command("tail <bot>"))
    .description(
      "List recent messages of a bot's approved chats, as the agent's chat tools see them",
    )
    .option("--minutes <n>", "only messages from the last n minutes", String(DEFAULT_MINUTES))
    .option("--limit <n>", `at most n messages, up to ${MAX_LIMIT}`, String(DEFAULT_LIMIT))
    .option("--text", "also print each message's text, clipped to one line")
    .option(
      "--table <name>",
      `state table (default: $${STATE_TABLE_ENV}, else the ${STATE_TABLE_PARAMETER} parameter)`,
    )
    .action(async (bot: string, flags: TailFlags) => {
      const platform = await requireConnection(context.store, bot, flags.platform);
      const tail = await readTail(context.store, context.chatAccess, bot, platform, {
        minutes: parseCount("--minutes", flags.minutes),
        limit: parseCount("--limit", flags.limit, MAX_LIMIT),
        table: flags.table,
      });
      context.log(formatTail(bot, tail, flags.text ?? false).join("\n"));
    });
}
