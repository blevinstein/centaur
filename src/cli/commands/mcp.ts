import type { Command } from "commander";
import {
  mcpApprovalParameter,
  mcpApprovalRecord,
  repoParameter,
} from "../../lambda/connection-paths.js";
import type { CliContext } from "../context.js";
import { formatMcpApproval, listMcpApprovals } from "../mcp-approvals.js";
import { definitionToApprove, readGlobalPolicy } from "../mcp-approve.js";
import { CliError, listBotConnections, parseName } from "../registry.js";
import { GLOBAL_POLICY_OPTION } from "./config.js";

const CLI_APPROVER = "cli";

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
    .command("approve")
    .argument("<bot>", "the bot")
    .argument("<server>", "the mcp_servers entry to approve")
    .option("--yes", "approve the definition shown; without it nothing is written")
    .option("--root <dir>", "the Centaur root inside the repository (default: .)")
    .option(...GLOBAL_POLICY_OPTION)
    .description(
      "Pre-approve the MCP server definition in the bot's default-branch config, so its first turn needs no request",
    )
    .action(
      async (
        bot: string,
        server: string,
        options: { yes?: boolean; root?: string; globalPolicy?: string },
      ) => {
        await requireBot(context, bot);
        parseName("MCP server", server);
        const repository = await context.store.get(repoParameter(bot));
        if (!repository) throw new CliError(`Bot "${bot}" is not bound to a repository.`);
        const definition = await definitionToApprove({
          bot,
          repository,
          root: options.root,
          server,
          github: await context.github(),
          globalPolicy: await readGlobalPolicy(options.globalPolicy),
        });
        if (!definition) {
          context.log(
            `The operator policy allows server "${server}" without approval; nothing to approve.`,
          );
          return;
        }
        const parameter = mcpApprovalParameter(bot, server, definition.fingerprint);
        context.log(
          [
            `Server "${server}" (${definition.fingerprint}) of ${repository}:`,
            ...definition.description,
          ].join("\n  "),
        );
        if (await context.store.get(parameter)) {
          context.log(`Already approved for bot "${bot}".`);
          return;
        }
        if (!options.yes) {
          throw new CliError("Pass --yes to approve this exact definition.");
        }
        await context.store.put(parameter, mcpApprovalRecord(CLI_APPROVER), { secure: false });
        context.log(`Approved server "${server}" for bot "${bot}".`);
      },
    );

  mcp
    .command("revoke")
    .argument("<bot>", "the bot")
    .argument("<server>", "the mcp_servers entry whose approval to remove")
    .description("Remove the approval of an MCP server, for every definition or one fingerprint")
    .option("--fingerprint <hex>", "remove only the approval of this definition")
    .action(async (bot: string, server: string, options: { fingerprint?: string }) => {
      await requireBot(context, bot);
      parseName("MCP server", server);
      const matching = (await listMcpApprovals(context.store, bot)).filter(
        (approval) =>
          approval.name === server &&
          (options.fingerprint === undefined || approval.fingerprint === options.fingerprint),
      );
      if (matching.length === 0) {
        throw new CliError(
          `No approval for server "${server}"${options.fingerprint ? ` with fingerprint ${options.fingerprint}` : ""} on bot "${bot}".`,
        );
      }
      context.log(`Revoking:\n${matching.map(formatMcpApproval).join("\n")}`);
      await context.store.delete(matching.map(({ parameter }) => parameter));
      context.log(`Revoked ${matching.length} approval(s) for server "${server}" on bot "${bot}".`);
    });
}
