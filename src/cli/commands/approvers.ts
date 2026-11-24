import type { Command } from "commander";
import {
  adminParameter,
  decodeEntry,
  encodeEntry,
  subjectIdOf,
} from "../../lambda/access-entries.js";
import { MAX_APPROVERS } from "../../lambda/approvers.js";
import { approverParameter, approversPrefix } from "../../lambda/connection-paths.js";
import type { CliContext } from "../context.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { CliError, requireConnection } from "../registry.js";

export function registerApproversCommands(program: Command, context: CliContext): void {
  const approvers = program
    .command("approvers")
    .description("Manage the users who may decide MCP approvals besides the admin");

  const connection = async (bot: string, { platform }: PlatformOptions) => {
    const resolved = await requireConnection(context.store, bot, platform);
    return {
      platform: resolved,
      admin: await context.store.get(adminParameter(resolved)),
      names: (await context.store.listNames(approversPrefix(bot, resolved))).sort(),
    };
  };

  withPlatformOption(approvers.command("list <bot>"))
    .description("List the approvers of a bot's connection")
    .action(async (bot: string, options: PlatformOptions) => {
      const { platform, admin, names } = await connection(bot, options);
      const lines = await Promise.all(
        names.map(async (name) => {
          const { at, approver } = decodeEntry((await context.store.get(name)) ?? "");
          return `${subjectIdOf(name)}  ${at}  added by ${approver ?? "the CLI"}`;
        }),
      );
      context.log(
        [
          lines.length > 0 ? lines.join("\n") : `No approvers for "${bot}" on ${platform}.`,
          `The admin (${admin ?? "none"}) is always an approver.`,
        ].join("\n"),
      );
    });

  withPlatformOption(approvers.command("add <bot> <userId>"))
    .description("Authorize a user to decide MCP approvals")
    .action(async (bot: string, userId: string, options: PlatformOptions) => {
      const { platform, admin, names } = await connection(bot, options);
      if (!admin) {
        throw new CliError(
          `No admin is set for ${platform}: approvers have no effect without one. Run "centaur admin set" first.`,
        );
      }
      if (userId === admin) {
        throw new CliError(`${userId} is the admin for ${platform}, who is always an approver.`);
      }
      const parameter = approverParameter(bot, platform, userId);
      if (names.includes(parameter)) {
        context.log(`${userId} is already an approver for bot "${bot}".`);
        return;
      }
      if (names.length >= MAX_APPROVERS) {
        throw new CliError(
          `Bot "${bot}" already has ${MAX_APPROVERS} approvers on ${platform}; remove one first.`,
        );
      }
      await context.store.put(parameter, encodeEntry(), { secure: false });
      context.log(`Added approver ${userId} for bot "${bot}".`);
    });

  withPlatformOption(approvers.command("remove <bot> <userId>"))
    .description("Remove an approver")
    .action(async (bot: string, userId: string, options: PlatformOptions) => {
      const { platform, names } = await connection(bot, options);
      const parameter = approverParameter(bot, platform, userId);
      if (!names.includes(parameter)) throw new CliError(`Approver ${userId} not found.`);
      await context.store.delete([parameter]);
      context.log(`Removed approver ${userId} for bot "${bot}".`);
    });
}
