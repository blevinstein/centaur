import type { Command } from "commander";

export interface PlatformOptions {
  platform?: string;
}

/** `--platform` picks one of a bot's connections; it may be omitted when the bot has exactly one. */
export const withPlatformOption = (command: Command): Command =>
  command.option("--platform <platform>", "the connection to act on (required with several)");
