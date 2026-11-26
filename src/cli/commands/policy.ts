import type { Command } from "commander";
import { parseCentaurConfig } from "../../config/index.js";
import { checkToolCall } from "../../config/mcp-policy.js";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";
import { GLOBAL_POLICY_OPTION, readConfig, readPolicyLayers } from "./config.js";

function parseArgs(text: string) {
  try {
    const args: unknown = JSON.parse(text);
    if (args !== null && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
  } catch {}
  throw new CliError("--args must be a JSON object");
}

export function registerPolicyCommands(program: Command, context: CliContext): void {
  const policy = program.command("policy").description("Work with the MCP operator policy");

  policy
    .command("check-call [path]")
    .requiredOption("--server <name>", "the MCP server name")
    .requiredOption("--tool <name>", "the tool name, without the mcp__<server>__ prefix")
    .option("--args <json>", "the call's arguments, as a JSON object", "{}")
    .option(...GLOBAL_POLICY_OPTION)
    .option("--root <dir>", "the Centaur root, relative to the current directory (default: .)")
    .description(
      "Dry-run one MCP tool call against the local .centaur/mcp-policy.cedar next to the config (the bot comes from the config) and print whether it is allowed or refused, and by which policy",
    )
    .action(
      async (
        explicitPath: string | undefined,
        options: {
          server: string;
          tool: string;
          args: string;
          globalPolicy?: string;
          root?: string;
        },
      ) => {
        const { path, text } = await readConfig(explicitPath, options.root);
        const result = parseCentaurConfig(text);
        if (!result.ok) throw new CliError(`${path} is invalid`);
        const refusal = checkToolCall(
          result.config.bot,
          { server: options.server, tool: options.tool, args: parseArgs(options.args) },
          await readPolicyLayers(path, options.globalPolicy),
        );
        context.log(refusal === undefined ? "allowed" : `refused: ${refusal}`);
      },
    );
}
