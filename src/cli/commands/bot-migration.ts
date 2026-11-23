import { chmod, readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import type { Platform } from "../../config/index.js";
import { connectionPath } from "../../lambda/connection-paths.js";
import { buildBackup, parseBackup } from "../backup.js";
import type { CliContext } from "../context.js";
import { type MigrationPlan, planMigration } from "../migrate.js";
import { type CopyPlan, classifyCopies, writeVerified } from "../parameter-copy.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import {
  CliError,
  listBotConnections,
  parseName,
  parsePlatform,
  requireConnection,
} from "../registry.js";

const BACKUP_FILE_MODE = 0o600;

const collect = (value: string, previous: string[]) => [...previous, value];

const readFileOrFail = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      `Cannot read ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
    );
  });

function parseAliasPlatforms(entries: string[]): Map<string, Platform> {
  return new Map(
    entries.map((entry) => {
      const [alias, platform, ...extra] = entry.split("=");
      if (!alias || !platform || extra.length > 0) {
        throw new CliError(`Invalid --alias-platform "${entry}": expected <alias>=<platform>.`);
      }
      return [parseName("alias", alias), parsePlatform(platform)];
    }),
  );
}

const describeCopies = (verb: string, plans: CopyPlan[]) =>
  plans.map(({ source, target }) => `${verb} ${source.name} -> ${target}`);

function describeProblems(plan: MigrationPlan): string[] {
  return [
    ...plan.problems.map((problem) => `problem: ${problem}`),
    ...plan.unresolvedAliases.map(
      ({ alias, chatId, candidates }) =>
        `unresolved alias "${alias}" (chat ${chatId}): ${
          candidates.length > 1
            ? `approved on ${candidates.join(" and ")}`
            : "no bot has approved this chat"
        }; pass --alias-platform ${alias}=<platform> or --drop-alias ${alias}`,
    ),
    ...plan.unrecognized.map((name) => `skipped unrecognized parameter ${name}`),
  ];
}

const isBlocked = (plan: MigrationPlan) =>
  plan.problems.length > 0 || plan.unresolvedAliases.length > 0;

export function registerBotMigrationCommands(bot: Command, context: CliContext): void {
  bot
    .command("export <file>")
    .option("--force", "overwrite an existing file")
    .description(
      "Back up every bot's parameters, chat aliases and the admin to a JSON file (mode 0600). The file holds secrets in plain text: keep it outside any repo",
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

  bot
    .command("migrate")
    .option("--dry-run", "list what would be copied or pruned and write nothing")
    .option("--prune", "delete the flat parameters and flat chat aliases (after the soak)")
    .option("--alias-platform <alias=platform>", "platform for a flat chat alias", collect, [])
    .option("--drop-alias <alias>", "do not migrate a flat chat alias", collect, [])
    .description(
      "Copy the flat SSM layout and chat aliases to the nested layout, verify each copy and leave the flat parameters in place; safe to re-run",
    )
    .action(
      async (options: {
        dryRun?: boolean;
        prune?: boolean;
        aliasPlatform: string[];
        dropAlias: string[];
      }) => {
        const plan = await planMigration(context.store, {
          aliasPlatforms: parseAliasPlatforms(options.aliasPlatform),
          droppedAliases: new Set(options.dropAlias.map((alias) => parseName("alias", alias))),
        });
        const { missing, unchanged, differing } = await classifyCopies(context.store, plan.copies);
        const problems = describeProblems(plan);
        if (!options.dryRun && isBlocked(plan)) {
          throw new CliError(`Nothing was changed:\n${problems.join("\n")}`);
        }

        if (options.prune) {
          const blockers = [...missing, ...differing].map(({ target }) => target);
          if (blockers.length > 0 && !options.dryRun) {
            throw new CliError(
              `Nothing was deleted: ${blockers.length} flat parameters have no identical nested copy; run "centaur bot migrate" or resolve the difference:\n${blockers.join("\n")}`,
            );
          }
          if (!options.dryRun) await context.store.delete(plan.flat);
          context.log(
            [
              ...problems,
              ...blockers.map((name) => `blocked by ${name}`),
              ...plan.flat.map((name) => `${options.dryRun ? "would delete" : "deleted"} ${name}`),
              `${options.dryRun ? "Would delete" : "Deleted"} ${plan.flat.length} flat parameters.`,
            ].join("\n"),
          );
          return;
        }

        if (!options.dryRun) await writeVerified(context.store, missing);
        context.log(
          [
            ...problems,
            ...describeCopies(options.dryRun ? "would copy" : "copied", missing),
            ...describeCopies("kept (the nested parameter differs)", differing),
            `${options.dryRun ? "Would copy" : "Copied and verified"} ${missing.length} parameters; ${unchanged.length} already match, ${differing.length} differ and were kept.`,
            "The flat parameters are untouched. The registry entry is not migrated: run register for each bot after deploying.",
          ].join("\n"),
        );
      },
    );

  withPlatformOption(bot.command("adopt <source> <target>"))
    .description(
      "Copy a bot's connection (secrets, approved and blocked entries) into another bot that has no connection on that platform; the source is left untouched",
    )
    .action(async (source: string, target: string, options: PlatformOptions) => {
      parseName("bot", source);
      parseName("bot", target);
      if (source === target) throw new CliError("The source and the target must differ.");
      const platform = await requireConnection(context.store, source, options.platform);
      const targetConnections = (await listBotConnections(context.store, target)).get(target);
      if (!targetConnections) throw new CliError(`Unknown bot "${target}".`);
      if (targetConnections.has(platform)) {
        throw new CliError(
          `Bot "${target}" already has a ${platform} connection; remove it first.`,
        );
      }
      const sourceBase = connectionPath(source, platform);
      const copies = (await context.store.getByPath(`${sourceBase}/`)).map((parameter) => ({
        source: parameter,
        target: `${connectionPath(target, platform)}${parameter.name.slice(sourceBase.length)}`,
      }));
      await writeVerified(context.store, copies);
      context.log(
        `Copied ${copies.length} parameters from the ${platform} connection of "${source}" to "${target}"; "${source}" is untouched. Chat aliases are shared per platform and need no copy. Threads under "${source}" start fresh under "${target}": merge or close their open pull requests, point the ${platform} webhook or event URL at "${target}", then retire "${source}".`,
      );
    });
}
