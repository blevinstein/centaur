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
import { proposeChatAlias } from "../../lambda/chat-aliases.js";
import { knownChatAliases } from "../chat-aliases.js";
import type { CliContext } from "../context.js";
import {
  CliError,
  chatParameter,
  type Platform,
  parseName,
  requireBotPlatform,
} from "../registry.js";

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
    alias?: string | undefined;
  }

  const run =
    (action: (subject: Subject) => Promise<string>) =>
    async (
      bot: string,
      kind: string,
      id: string,
      options: { name?: string; alias?: string } = {},
    ) => {
      const platform = await requireBotPlatform(context.store, bot);
      context.log(await action({ bot, platform, kind: parseKind(kind), id, ...options }));
    };

  const remove = async (name: string, what: string) => {
    if ((await context.store.get(name)) === undefined) throw new CliError(`${what} not found.`);
    await context.store.delete([name]);
  };

  const chatAliasFor = async (
    id: string,
    name: string | undefined,
    requested: string | undefined,
  ) => {
    const known = await knownChatAliases(context.store);
    if (requested === undefined) return proposeChatAlias(known, id, name);
    parseName("alias", requested);
    const holder = known[chatParameter(requested)];
    if (holder !== undefined && holder !== id) {
      throw new CliError(`Alias "${requested}" already names chat ${holder}.`);
    }
    return requested;
  };

  subjectCommand("approve", "Approve a chat or user (kind: chat or user)")
    .option("--name <name>", "display name to record; a chat's alias defaults to a slug of it")
    .option("--alias <alias>", "chat alias to create (chats only)")
    .action(
      run(async ({ bot, kind, id, name, alias }) => {
        if (kind === "user" && alias !== undefined) {
          throw new CliError("--alias applies to chats only.");
        }
        const stored = decodeEntry(
          (await context.store.get(approvedParameter(bot, kind, id))) ?? "",
        );
        const displayName = name ?? stored.name;
        const chatAlias = kind === "chat" ? await chatAliasFor(id, displayName, alias) : undefined;
        if (chatAlias) await context.store.put(chatParameter(chatAlias), id, { secure: false });
        await context.store.put(
          approvedParameter(bot, kind, id),
          encodeEntry({ name: displayName, alias: chatAlias }),
          { secure: false },
        );
        return `Approved ${kind} ${id} for bot "${bot}"${chatAlias ? ` as "${chatAlias}"` : ""}.`;
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
      await context.store.put(blockedParameter(bot, kind, id), encodeEntry(), {
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
