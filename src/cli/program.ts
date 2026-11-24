import { Command } from "commander";
import { registerAccessCommands } from "./commands/access.js";
import { registerAdminCommands } from "./commands/admin.js";
import { registerApproversCommands } from "./commands/approvers.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerDestinationCommands } from "./commands/destinations.js";
import { registerGithubTokenCommands } from "./commands/github-token.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerRepoCommands } from "./commands/repo.js";
import type { CliContext } from "./context.js";

export function buildProgram(context: CliContext): Command {
  const program = new Command("centaur").exitOverride().configureOutput({
    writeOut: (text) => context.log(text.trimEnd()),
    writeErr: (text) => context.log(text.trimEnd()),
  });
  registerBotCommands(program, context);
  registerDestinationCommands(program, context);
  registerAdminCommands(program, context);
  registerAccessCommands(program, context);
  registerApproversCommands(program, context);
  registerGithubTokenCommands(program, context);
  registerConfigCommands(program, context);
  registerChatCommands(program, context);
  registerMcpCommands(program, context);
  registerRepoCommands(program, context);
  return program;
}
