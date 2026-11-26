export const COMMANDS = ["new", "resume", "transcript"] as const;
export type Command = (typeof COMMANDS)[number];

/** A mention of the bot that opens the message: Slack renders it as `<@U…>` or `@name`. */
const LEADING_MENTION = String.raw`(?:(?:<@[^>\s]+>|@[\w.-]+)\s+)?`;

const COMMAND_PATTERN = new RegExp(
  `^${LEADING_MENTION}/(${COMMANDS.join("|")})(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`,
  "i",
);

export interface ParsedMessage {
  command: Command | undefined;
  text: string;
}

export function parseCommand(text: string): ParsedMessage {
  const trimmed = text.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) return { command: undefined, text: trimmed };
  return { command: (match[1] as string).toLowerCase() as Command, text: (match[2] ?? "").trim() };
}
