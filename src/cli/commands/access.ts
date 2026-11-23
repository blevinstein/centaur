import type { Command } from "commander";
import {
  ACCESS_KINDS,
  type AccessKind,
  adminParameter,
  decodeEntry,
  encodeEntry,
  subjectIdOf,
} from "../../lambda/access-entries.js";
import {
  approvedParameter,
  approvedPrefix,
  blockedParameter,
  blockedPrefix,
  scopedChatParameter,
} from "../../lambda/connection-paths.js";
import { encodeDestination, proposeDestinationName } from "../../lambda/destinations.js";
import type { CliContext } from "../context.js";
import { knownDestinations } from "../destinations.js";
import { type PlatformOptions, withPlatformOption } from "../platform-option.js";
import { CliError, type Platform, parseName, requireConnection } from "../registry.js";

function parseKind(value: string): AccessKind {
  if (!ACCESS_KINDS.includes(value as AccessKind)) {
    throw new CliError(`Unknown kind "${value}": expected ${ACCESS_KINDS.join(" or ")}.`);
  }
  return value as AccessKind;
}

export function registerAccessCommands(program: Command, context: CliContext): void {
  const access = program
    .command("access")
    .description("Manage the chats and users a bot has approved or blocked");

  const subjectCommand = (name: string, description: string) =>
    withPlatformOption(access.command(`${name} <bot> <kind> <id>`)).description(description);

  interface Subject {
    bot: string;
    platform: Platform;
    kind: AccessKind;
    id: string;
    name?: string | undefined;
    alias?: string | undefined;
  }

  const run =
    (action: (subject: Subject) => Promise<string>) =>
    async (
      bot: string,
      kind: string,
      id: string,
      { platform: requested, ...options }: PlatformOptions & { name?: string; alias?: string } = {},
    ) => {
      const platform = await requireConnection(context.store, bot, requested);
      context.log(await action({ bot, platform, kind: parseKind(kind), id, ...options }));
    };

  const remove = async (name: string, what: string) => {
    if ((await context.store.get(name)) === undefined) throw new CliError(`${what} not found.`);
    await context.store.delete([name]);
  };

  const destinationFor = async (
    platform: Platform,
    id: string,
    displayName: string | undefined,
    requested: string | undefined,
  ) => {
    const known = await knownDestinations(context.store, platform);
    const destinationName =
      requested === undefined ? proposeDestinationName(known, id, displayName) : requested;
    if (requested !== undefined) {
      parseName("destination", requested);
      const holder = known[scopedChatParameter(platform, requested)]?.chatId;
      if (holder !== undefined && holder !== id) {
        throw new CliError(`Destination "${requested}" already holds chat ${holder}.`);
      }
    }
    const parameter = scopedChatParameter(platform, destinationName);
    if (!(parameter in known)) {
      await context.store.put(parameter, encodeDestination({ chatId: id, name: displayName }), {
        secure: false,
      });
    }
    return destinationName;
  };

  subjectCommand("approve", "Approve a chat or user (kind: chat or user)")
    .option(
      "--name <name>",
      "display name to record; a chat's destination name defaults to a slug of it",
    )
    .option("--alias <name>", "destination name to create for the chat (chats only)")
    .action(
      run(async ({ bot, platform, kind, id, name, alias }) => {
        if (kind === "user" && alias !== undefined) {
          throw new CliError("--alias applies to chats only.");
        }
        const stored = decodeEntry(
          (await context.store.get(approvedParameter(bot, platform, kind, id))) ?? "",
        );
        const displayName = name ?? stored.name;
        const destinationName =
          kind === "chat" ? await destinationFor(platform, id, displayName, alias) : undefined;
        await context.store.put(
          approvedParameter(bot, platform, kind, id),
          encodeEntry({ name: displayName, alias: destinationName }),
          { secure: false },
        );
        return `Approved ${kind} ${id} for bot "${bot}"${destinationName ? ` as "${destinationName}"` : ""}.`;
      }),
    );

  subjectCommand("revoke", "Remove an approval").action(
    run(async ({ bot, platform, kind, id }) => {
      await remove(approvedParameter(bot, platform, kind, id), `Approved ${kind} ${id}`);
      return `Revoked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  subjectCommand("block", "Block a chat or user and remove its approval").action(
    run(async ({ bot, platform, kind, id }) => {
      if (kind === "user" && id === (await context.store.get(adminParameter(platform)))) {
        throw new CliError(`Cannot block ${id}: they are the admin for ${platform}.`);
      }
      await context.store.put(blockedParameter(bot, platform, kind, id), encodeEntry(), {
        secure: false,
      });
      await context.store.delete([approvedParameter(bot, platform, kind, id)]);
      return `Blocked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  subjectCommand("unblock", "Remove a block").action(
    run(async ({ bot, platform, kind, id }) => {
      await remove(blockedParameter(bot, platform, kind, id), `Blocked ${kind} ${id}`);
      return `Unblocked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  withPlatformOption(access.command("list <bot>"))
    .description("List approved and blocked chats and users")
    .action(async (bot: string, options: PlatformOptions) => {
      const platform = await requireConnection(context.store, bot, options.platform);
      const sections = ACCESS_KINDS.flatMap((kind) => [
        { label: "approved", kind, prefix: approvedPrefix(bot, platform, kind) },
        { label: "blocked", kind, prefix: blockedPrefix(bot, platform, kind) },
      ]);
      const lines: string[] = [];
      for (const { label, kind, prefix } of sections) {
        for (const parameter of (await context.store.listNames(prefix)).sort()) {
          const { name, alias, at } = decodeEntry((await context.store.get(parameter)) ?? "");
          const columns = [label, kind, subjectIdOf(parameter), name ?? "-", at];
          lines.push([...columns, ...(alias ? [`alias=${alias}`] : [])].join("  "));
        }
      }
      context.log(
        lines.length > 0 ? lines.join("\n") : `Nothing approved or blocked for "${bot}".`,
      );
    });
}
