import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { validateMcpPolicy } from "../../config/index.js";
import { GLOBAL_MCP_POLICY_PARAMETER, mcpPolicyParameter } from "../../lambda/parameters.js";
import type { CliContext } from "../context.js";
import { CliError, requireBotPlatform } from "../registry.js";

interface PolicyOptions {
  bot?: string;
}

const BOT_OPTION = ["--bot <bot>", "target one bot's policy instead of the global one"] as const;

export function registerMcpPolicyCommands(program: Command, context: CliContext): void {
  const policy = program
    .command("mcp-policy")
    .description("Manage the Cedar policy that decides which MCP servers a repo may register");

  const locate = async ({ bot }: PolicyOptions) => {
    if (bot === undefined) {
      return { name: GLOBAL_MCP_POLICY_PARAMETER, label: "global MCP policy" };
    }
    await requireBotPlatform(context.store, bot);
    return { name: mcpPolicyParameter(bot), label: `MCP policy for bot "${bot}"` };
  };

  policy
    .command("set")
    .requiredOption("--file <path>", "Cedar policy file to store")
    .option(...BOT_OPTION)
    .description("Validate a policy file against the MCP schema and store it")
    .action(async (options: PolicyOptions & { file: string }) => {
      const text = await readFile(options.file, "utf8").catch((error: NodeJS.ErrnoException) => {
        throw new CliError(
          `Cannot read ${options.file}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
        );
      });
      const errors = validateMcpPolicy(text);
      if (errors.length > 0) {
        throw new CliError(`${options.file} is invalid:\n${errors.join("\n")}`);
      }
      const { name, label } = await locate(options);
      await context.store.put(name, text, { secure: false });
      context.log(`Stored the ${label}.`);
    });

  policy
    .command("show")
    .option(...BOT_OPTION)
    .description("Print the stored policy; with --bot, the global policy it is merged with too")
    .action(async (options: PolicyOptions) => {
      const sections = [{ heading: "global policy", name: GLOBAL_MCP_POLICY_PARAMETER }];
      if (options.bot !== undefined) {
        const { name } = await locate(options);
        sections.push({ heading: `policy for bot "${options.bot}"`, name });
      }
      const blocks = await Promise.all(
        sections.map(async ({ heading, name }) => {
          const text = await context.store.get(name);
          return text === undefined ? `// ${heading}: not set` : `// ${heading}\n${text}`;
        }),
      );
      context.log(blocks.join("\n\n"));
    });

  policy
    .command("clear")
    .option(...BOT_OPTION)
    .description("Delete a stored policy")
    .action(async (options: PolicyOptions) => {
      const { name, label } = await locate(options);
      if ((await context.store.get(name)) === undefined) throw new CliError(`No ${label} is set.`);
      await context.store.delete([name]);
      context.log(`Cleared the ${label}.`);
    });
}
