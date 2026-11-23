import { isMap, isScalar, LineCounter, type Pair, parseDocument } from "yaml";
import { formatIssues, PLATFORMS, parseCentaurConfig } from "../config/index.js";

const LEGACY_KEYS = ["platform", "respond_to", "handle"] as const;
const INDENT = "  ";
const COMMENT_LINE = /^\s*#/;

export class ConfigMigrationError extends Error {}

const keyName = (pair: Pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined);

/**
 * Moves the legacy top-level `platform`, `respond_to` and `handle` under `platforms.<platform>`.
 * The YAML parser locates the keys; the text is spliced line by line, so everything else (comments,
 * key order, spacing, quoting) stays byte for byte. A comment block directly above `respond_to` or
 * `handle` moves with it. Returns the text unchanged when the file already declares `platforms`.
 */
export function migrateConfigText(text: string): string {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) {
    throw new ConfigMigrationError(`invalid YAML: ${document.errors[0]?.message}`);
  }
  const root = document.contents;
  if (!isMap(root)) throw new ConfigMigrationError("the config must be a YAML mapping");

  const legacy = root.items.filter((pair) => LEGACY_KEYS.some((key) => key === keyName(pair)));
  if (legacy.length === 0) {
    if (root.has("platforms")) return text;
    throw new ConfigMigrationError(
      "declares no platform: add `platforms: { <platform>: {} }` by hand",
    );
  }
  if (root.has("platforms")) {
    throw new ConfigMigrationError(
      "has both `platforms` and a legacy top-level key; remove one by hand",
    );
  }
  const platformPair = legacy.find((pair) => keyName(pair) === "platform");
  if (!platformPair) {
    throw new ConfigMigrationError("has `respond_to` or `handle` but no `platform` to move it to");
  }
  const platform = isScalar(platformPair.value) ? platformPair.value.value : undefined;
  if (!PLATFORMS.some((candidate) => candidate === platform)) {
    throw new ConfigMigrationError(
      `has platform ${JSON.stringify(platform)}; expected one of ${PLATFORMS.join(", ")}`,
    );
  }

  const lines = text.split("\n");
  const lineOf = (offset: number) => lineCounter.linePos(offset).line - 1;
  const location = (pair: Pair) => {
    const range =
      isScalar(pair.key) && isScalar(pair.value) ? [pair.key.range, pair.value.range] : [];
    const [keyRange, valueRange] = range;
    if (!keyRange || !valueRange || lineOf(keyRange[0]) !== lineOf(valueRange[1])) {
      throw new ConfigMigrationError(
        `has a ${keyName(pair)} that is not a single-line scalar; move it by hand`,
      );
    }
    return { line: lineOf(keyRange[0]), valueEnd: lineCounter.linePos(valueRange[1]).col - 1 };
  };

  const moved = legacy.filter((pair) => pair !== platformPair).map(location);
  const blocks = moved.map(({ line }) => {
    let start = line;
    while (start > 0 && COMMENT_LINE.test(lines[start - 1] ?? "")) start--;
    return { start, line };
  });
  const platformAt = location(platformPair);
  const indent = /^\s*/.exec(lines[platformAt.line] ?? "")?.[0] ?? "";
  const platformsBlock = [
    `${indent}platforms:${(lines[platformAt.line] ?? "").slice(platformAt.valueEnd)}`,
    `${indent}${INDENT}${platform}:${blocks.length === 0 ? " {}" : ""}`,
    ...blocks.flatMap(({ start, line }) =>
      lines.slice(start, line + 1).map((original) => `${INDENT}${INDENT}${original}`),
    ),
  ];

  const removed = new Set(
    blocks.flatMap(({ start, line }) => lines.slice(start, line + 1).map((_, i) => start + i)),
  );
  const migrated = lines
    .flatMap((original, index) =>
      index === platformAt.line ? platformsBlock : removed.has(index) ? [] : [original],
    )
    .join("\n");

  const result = parseCentaurConfig(migrated);
  if (!result.ok) {
    throw new ConfigMigrationError(`the migrated file is invalid:\n${formatIssues(result.issues)}`);
  }
  return migrated;
}
