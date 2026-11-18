import type { Command } from "commander";
import { adminParameter } from "../../lambda/access-entries.js";
import {
  adminClaimParameter,
  DEFAULT_CLAIM_TTL_MINUTES,
  decodeClaim,
  encodeClaim,
  generateClaimCode,
  MAX_CLAIM_TTL_MINUTES,
} from "../../lambda/admin-claim-record.js";
import type { CliContext } from "../context.js";
import {
  botParameter,
  CliError,
  PLATFORM_NAMES,
  type Platform,
  requireBotPlatform,
  selectedPlatformIds,
} from "../registry.js";

function parseTtlMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CLAIM_TTL_MINUTES) {
    throw new CliError(`--ttl-minutes must be a whole number from 1 to ${MAX_CLAIM_TTL_MINUTES}.`);
  }
  return minutes;
}

export function registerAdminCommands(program: Command, context: CliContext): void {
  const admin = program
    .command("admin")
    .description("Manage the admin who approves access requests (one user ID per platform)");

  const set = admin.command("set").description("Record the admin's user ID per platform");
  const remove = admin.command("remove").description("Forget the admin's user ID per platform");
  for (const platform of PLATFORM_NAMES) {
    set.option(`--${platform} <id>`, `admin's ${platform} user ID`);
    remove.option(`--${platform}`, `forget the ${platform} admin`);
  }

  set.action(async (options: Record<string, string | undefined>) => {
    const ids = selectedPlatformIds(options);
    for (const { platform, id } of ids) {
      await context.store.put(adminParameter(platform), id, { secure: false });
    }
    context.log(`Set the admin for ${ids.map(({ platform }) => platform).join(", ")}.`);
  });

  remove.action(async (options: Record<string, boolean | undefined>) => {
    const platforms = selectedPlatformIds(options).map(({ platform }) => platform);
    for (const platform of platforms) {
      if ((await context.store.get(adminParameter(platform))) === undefined) {
        throw new CliError(`No admin is set for ${platform}.`);
      }
    }
    await context.store.delete(platforms.map(adminParameter));
    context.log(`Removed the admin for ${platforms.join(", ")}.`);
  });

  admin
    .command("show")
    .description("Show the admin's user ID per platform")
    .action(async () => {
      const lines = await Promise.all(
        PLATFORM_NAMES.map(
          async (platform) =>
            `${platform}: ${(await context.store.get(adminParameter(platform))) ?? "not set"}`,
        ),
      );
      context.log(lines.join("\n"));
    });

  const claimInstructions = async (platform: Platform, bot: string, code: string) => {
    if (platform === "slack") return `Send the bot a direct message: claim ${code}`;
    const token = await context.store.get(botParameter(bot, "token"));
    if (!token) throw new CliError(`Bot "${bot}" has no token.`);
    try {
      const { username } = await context.telegram.getMe(token);
      return `Open https://t.me/${username}?start=${code}`;
    } catch (error) {
      throw new CliError(
        `Could not look up the bot's username from Telegram: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };

  admin
    .command("claim <bot>")
    .description(
      "Let the first person to send a one-time code to the bot become its platform's admin",
    )
    .option(
      "--ttl-minutes <minutes>",
      "how long the code stays valid",
      parseTtlMinutes,
      DEFAULT_CLAIM_TTL_MINUTES,
    )
    .option("--cancel", "delete the pending claim instead of creating one")
    .action(async (bot: string, options: { ttlMinutes: number; cancel?: boolean }) => {
      const platform = await requireBotPlatform(context.store, bot);
      const parameter = adminClaimParameter(platform);
      if (options.cancel) {
        if (decodeClaim(await context.store.get(parameter))?.bot !== bot) {
          throw new CliError(`No pending claim for bot "${bot}".`);
        }
        await context.store.delete([parameter]);
        context.log(`Cancelled the pending claim for bot "${bot}".`);
        return;
      }
      const code = generateClaimCode();
      const instructions = await claimInstructions(platform, bot, code);
      const expiresAt = new Date(Date.now() + options.ttlMinutes * 60_000);
      await context.store.put(parameter, encodeClaim(bot, code, expiresAt), { secure: false });
      context.log(
        `${instructions}\nThe code works once, in a direct message to the bot, for ${options.ttlMinutes} minutes. Running this again replaces it.`,
      );
    });
}
