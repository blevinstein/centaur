import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { formatIssues, parseCentaurConfig } from "../../config/index.js";
import { CONFIG_FILE } from "../../workflows/config-file.js";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";

export function registerConfigCommands(program: Command, context: CliContext): void {
  const config = program.command("config").description("Work with a repo's .centaur.yml");

  config
    .command("check [path]")
    .description("Validate a config file offline, without touching SSM")
    .action(async (path: string = CONFIG_FILE) => {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        throw new CliError(
          `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
        );
      });
      const result = parseCentaurConfig(text);
      if (!result.ok) throw new CliError(`${path} is invalid:\n${formatIssues(result.issues)}`);
      context.log(`${path} is valid.`);
    });
}
