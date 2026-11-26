import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_INSTRUCTIONS_MARKER } from "../../src/workflows/repository-instructions.js";

export const userMemoryPath = (home: string) => join(home, ".claude", "CLAUDE.md");

export const installedMemory = (home: string) =>
  readFile(userMemoryPath(home), "utf8").catch(() => undefined);

/** What the installed user memory holds for guides given as `[path, text]` pairs. */
export const memoryOf = (...guides: [path: string, text: string][]) =>
  [
    REPOSITORY_INSTRUCTIONS_MARKER,
    guides.map(([path, text]) => `<!-- from ${path} -->\n${text}`).join("\n\n"),
  ].join("\n");

export async function writeUserMemory(home: string, text: string) {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(userMemoryPath(home), text);
}
