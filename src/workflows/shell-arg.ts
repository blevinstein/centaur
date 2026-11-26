const PLAIN = /^[\w@%+=:,./-]+$/;
const DOUBLE_QUOTE_UNSAFE = /["\\$`]/;

/** Single-quotes `value` so a shell parser reads it back verbatim. */
export const singleQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Double-quotes `value`, falling back to single quotes when it holds a character special inside them. */
export const doubleQuote = (value: string) =>
  DOUBLE_QUOTE_UNSAFE.test(value) ? singleQuote(value) : `"${value}"`;

/** Returns `value` unchanged when it is plain, otherwise single-quoted. */
export const shellArg = (value: string) => (PLAIN.test(value) ? value : singleQuote(value));
