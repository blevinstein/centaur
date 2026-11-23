const SENTENCE_BOUNDARY = /(?<=\w[.?!])\s/;
const SPLITTERS = [/\n+/, SENTENCE_BOUNDARY, /\s+/];

/** Cuts text into pieces of at most `maxChars` characters each. */
function hardSplit(text: string, maxChars: number) {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += maxChars) {
    pieces.push(text.slice(start, start + maxChars));
  }
  return pieces;
}

/**
 * Splits text into chunks of at most `maxChars` characters. It breaks at newlines first, then at
 * sentence-ending punctuation, then at whitespace, and cuts by characters only a piece with no
 * whitespace that is still too long (a URL or an encoded blob). Pieces are then merged back into
 * chunks that stay within the limit. The chunks keep the text's order, but each chunk joins its
 * pieces with a newline: the original whitespace between pieces is not preserved.
 */
export function splitTextMaxChars(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`maxChars must be a positive integer: ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const pieces = SPLITTERS.reduce(
    (parts, splitter) => parts.flatMap((p) => (p.length <= maxChars ? [p] : p.split(splitter))),
    [text],
  )
    .flatMap((p) => (p.length <= maxChars ? [p] : hardSplit(p, maxChars)))
    .filter((p) => p !== "");

  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= maxChars) {
      chunks[chunks.length - 1] = `${last}\n${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks.length > 0 ? chunks : [""];
}
