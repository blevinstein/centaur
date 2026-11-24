import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { formatMcpApproval, listMcpApprovals } from "../mcp-approvals.js";
import { CliError, listBotConnections, parseName } from "../registry.js";

async function requireBot(context: CliContext, bot: string) {
  if (!(await listBotConnections(context.store, bot)).has(bot)) {
    throw new CliError(`Unknown bot "${bot}".`);
  }
}

export function registerMcpCommands(program: Command, context: CliContext): void {
  const mcp = program.command("mcp").description("Manage the MCP servers a bot has approved");

  mcp
    .command("approvals <bot>")
    .description("List the approved MCP server definitions")
    .action(async (bot: string) => {
      await requireBot(context, bot);
      const approvals = await listMcpApprovals(context.store, bot);
      context.log(
        approvals.length > 0
          ? approvals.map(formatMcpApproval).join("\n")
          : `No MCP servers approved for "${bot}".`,
      );
    });

  mcp
    .command("revoke <bot> <name>")
    .description("Remove the approval of an MCP server, for every definition or one fingerprint")
    .option("--fingerprint <hex>", "remove only the approval of this definition")
    .action(async (bot: string, name: string, options: { fingerprint?: string }) => {
      await requireBot(context, bot);
      parseName("MCP server", name);
      const matching = (await listMcpApprovals(context.store, bot)).filter(
        (approval) =>
          approval.name === name &&
          (options.fingerprint === undefined || approval.fingerprint === options.fingerprint),
      );
      if (matching.length === 0) {
        throw new CliError(
          `No approval for MCP server "${name}"${options.fingerprint ? ` with fingerprint ${options.fingerprint}` : ""} on bot "${bot}".`,
        );
      }
      context.log(`Revoking:\n${matching.map(formatMcpApproval).join("\n")}`);
      await context.store.delete(matching.map(({ parameter }) => parameter));
      context.log(`Revoked ${matching.length} approval(s) for "${name}" on bot "${bot}".`);
    });
}
