import type { Command } from "commander";
import {
  ACCESS_KINDS,
  type AccessKind,
  adminParameter,
  approvedParameter,
  approvedPrefix,
  blockedParameter,
  blockedPrefix,
  decodeEntry,
  encodeEntry,
  subjectIdOf,
} from "../../lambda/access-entries.js";
import type { CliContext } from "../context.js";
import { CliError, type Platform, requireBotPlatform } from "../registry.js";

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
    access.command(`${name} <bot> <kind> <id>`).description(description);

  interface Subject {
    bot: string;
    platform: Platform;
    kind: AccessKind;
    id: string;
    name?: string | undefined;
  }

  const run =
    (action: (subject: Subject) => Promise<string>) =>
    async (bot: string, kind: string, id: string, options: { name?: string } = {}) => {
      const platform = await requireBotPlatform(context.store, bot);
      context.log(await action({ bot, platform, kind: parseKind(kind), id, name: options.name }));
    };

  const remove = async (name: string, what: string) => {
    if ((await context.store.get(name)) === undefined) throw new CliError(`${what} not found.`);
    await context.store.delete([name]);
  };

  subjectCommand("approve", "Approve a chat or user (kind: chat or user)")
    .option("--name <name>", "display name to record")
    .action(
      run(async ({ bot, kind, id, name }) => {
        await context.store.put(approvedParameter(bot, kind, id), encodeEntry(name), {
          secure: false,
        });
        return `Approved ${kind} ${id} for bot "${bot}".`;
      }),
    );

  subjectCommand("revoke", "Remove an approval").action(
    run(async ({ bot, kind, id }) => {
      await remove(approvedParameter(bot, kind, id), `Approved ${kind} ${id}`);
      return `Revoked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  subjectCommand("block", "Block a chat or user and remove its approval").action(
    run(async ({ bot, platform, kind, id }) => {
      if (kind === "user" && id === (await context.store.get(adminParameter(platform)))) {
        throw new CliError(`Cannot block ${id}: they are the admin for ${platform}.`);
      }
      await context.store.put(blockedParameter(bot, kind, id), encodeEntry(undefined), {
        secure: false,
      });
      await context.store.delete([approvedParameter(bot, kind, id)]);
      return `Blocked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  subjectCommand("unblock", "Remove a block").action(
    run(async ({ bot, kind, id }) => {
      await remove(blockedParameter(bot, kind, id), `Blocked ${kind} ${id}`);
      return `Unblocked ${kind} ${id} for bot "${bot}".`;
    }),
  );

  access
    .command("list <bot>")
    .description("List approved and blocked chats and users")
    .action(async (bot: string) => {
      await requireBotPlatform(context.store, bot);
      const sections = ACCESS_KINDS.flatMap((kind) => [
        { label: "approved", kind, prefix: approvedPrefix(bot, kind) },
        { label: "blocked", kind, prefix: blockedPrefix(bot, kind) },
      ]);
      const lines: string[] = [];
      for (const { label, kind, prefix } of sections) {
        for (const parameter of (await context.store.listNames(prefix)).sort()) {
          const { name, at } = decodeEntry((await context.store.get(parameter)) ?? "");
          lines.push([label, kind, subjectIdOf(parameter), name ?? "-", at].join("  "));
        }
      }
      context.log(
        lines.length > 0 ? lines.join("\n") : `Nothing approved or blocked for "${bot}".`,
      );
    });
}
