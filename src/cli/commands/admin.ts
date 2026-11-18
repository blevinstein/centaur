import type { Command } from "commander";
import { adminParameter } from "../../lambda/access-entries.js";
import type { CliContext } from "../context.js";
import { CliError, PLATFORM_NAMES, selectedPlatformIds } from "../registry.js";

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
}
