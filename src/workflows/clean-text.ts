export const MAX_TITLE_LENGTH = 100;
export const MAX_BODY_LENGTH = 4000;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped on purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export const cleanTitle = (text: string | undefined) =>
  truncate(
    text?.replaceAll(/\s+/g, " ").replaceAll(CONTROL_CHARACTERS, "").trim() ?? "",
    MAX_TITLE_LENGTH,
  );

export const cleanBody = (text: string | undefined) =>
  truncate(
    text?.replaceAll("\r\n", "\n").replaceAll(CONTROL_CHARACTERS, "").trim() ?? "",
    MAX_BODY_LENGTH,
  );

/** Wraps untrusted text in a code fence longer than any backtick run inside it. */
export function fence(text: string, info = "") {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}
