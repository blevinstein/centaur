import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY_INSTRUCTIONS_MARKER } from "../../src/workflows/repository-instructions.js";

export const userMemoryPath = (home: string) => join(home, ".claude", "CLAUDE.md");

export const installedMemory = (home: string) =>
  readFile(userMemoryPath(home), "utf8").catch(() => undefined);

/** What the installed user memory holds for a guide with text `guide`. */
export const memoryOf = (guide: string) => `${REPOSITORY_INSTRUCTIONS_MARKER}\n${guide}`;

export async function writeUserMemory(home: string, text: string) {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(userMemoryPath(home), text);
}
