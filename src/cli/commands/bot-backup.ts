import { chmod, readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { buildBackup, parseBackup } from "../backup.js";
import type { CliContext } from "../context.js";
import { classifyCopies, writeVerified } from "../parameter-copy.js";
import { CliError } from "../registry.js";

const BACKUP_FILE_MODE = 0o600;

const readFileOrFail = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
    );
  });

export function registerBotBackupCommands(bot: Command, context: CliContext): void {
  bot
    .command("export <file>")
    .option("--force", "overwrite an existing file")
    .description(
      "Back up every bot's parameters, the chats and the admin entries to a JSON file (mode 0600). The file holds secrets in plain text: keep it outside any repo",
    )
    .action(async (file: string, options: { force?: boolean }) => {
      const backup = await buildBackup(context.store);
      await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`, {
        mode: BACKUP_FILE_MODE,
        flag: options.force ? "w" : "wx",
      }).catch((error: NodeJS.ErrnoException) => {
        throw new CliError(
          error.code === "EEXIST"
            ? `${file} already exists; pass --force to overwrite it.`
            : `Cannot write ${file}: ${error.message}`,
        );
      });
      await chmod(file, BACKUP_FILE_MODE);
      context.log(
        `Exported ${backup.parameters.length} parameters to ${file}. The file holds secrets in plain text; keep it private and delete it when it is no longer needed.`,
      );
    });

  bot
    .command("restore <file>")
    .option("--force", "overwrite parameters that exist with another value")
    .description(
      "Write a backup's parameters back to SSM and verify them; refuses to overwrite a differing parameter unless forced",
    )
    .action(async (file: string, options: { force?: boolean }) => {
      const { parameters } = parseBackup(await readFileOrFail(file));
      const { missing, unchanged, differing } = await classifyCopies(
        context.store,
        parameters.map((source) => ({ source, target: source.name })),
      );
      if (differing.length > 0 && !options.force) {
        throw new CliError(
          `${differing.length} parameters already exist with another value; pass --force to overwrite them:\n${differing.map(({ target }) => target).join("\n")}`,
        );
      }
      await writeVerified(context.store, [...missing, ...differing]);
      context.log(
        `Restored ${missing.length + differing.length} parameters (${differing.length} overwritten, ${unchanged.length} already present).`,
      );
    });
}
