import { Command } from "commander";
import { registerAllowlistCommands } from "./commands/allowlist.js";
import { registerBotCommands } from "./commands/bot.js";
import type { CliContext } from "./context.js";

export function buildProgram(context: CliContext): Command {
  const program = new Command("centaur").exitOverride().configureOutput({
    writeOut: (text) => context.log(text.trimEnd()),
    writeErr: (text) => context.log(text.trimEnd()),
  });
  registerBotCommands(program, context);
  registerAllowlistCommands(program, context);
  return program;
}
