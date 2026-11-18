import { Command } from "commander";
import { registerAccessCommands } from "./commands/access.js";
import { registerAdminCommands } from "./commands/admin.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerChatCommands } from "./commands/chats.js";
import { registerGithubTokenCommands } from "./commands/github-token.js";
import type { CliContext } from "./context.js";

export function buildProgram(context: CliContext): Command {
  const program = new Command("centaur").exitOverride().configureOutput({
    writeOut: (text) => context.log(text.trimEnd()),
    writeErr: (text) => context.log(text.trimEnd()),
  });
  registerBotCommands(program, context);
  registerChatCommands(program, context);
  registerAdminCommands(program, context);
  registerAccessCommands(program, context);
  registerGithubTokenCommands(program, context);
  return program;
}
