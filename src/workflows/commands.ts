export const COMMANDS = ["new", "resume", "transcript"] as const;
export type Command = (typeof COMMANDS)[number];

const COMMAND_PATTERN = new RegExp(`^/(${COMMANDS.join("|")})(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`, "i");

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
