import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The repository guides, in order of preference. */
export const REPOSITORY_GUIDES = ["AGENTS.md", "CLAUDE.md"];

/** First line of the file this module writes; a `CLAUDE.md` without it is never touched. */
export const REPOSITORY_INSTRUCTIONS_MARKER =
  "<!-- centaur: repository instructions, rewritten every turn -->";

export interface RepositoryInstructionsInstall {
  home: string;
  /** The trusted checkout's Centaur root; undefined removes the installed file. */
  rootDir: string | undefined;
  maxBytes: number;
}

const readIfPresent = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

/**
 * Makes `$HOME/.claude/CLAUDE.md`, the user memory Claude Code reads under `--setting-sources user`,
 * hold the trusted checkout's first existing guide (`AGENTS.md`, then `CLAUDE.md`), and returns the
 * guide's name. Removes the file it wrote earlier when there is nothing to install. Throws, rather
 * than truncate someone's rules, for a guide over `maxBytes`, and for a user memory it did not write.
 */
export async function installRepositoryInstructions({
  home,
  rootDir,
  maxBytes,
}: RepositoryInstructionsInstall) {
  const target = join(home, ".claude", "CLAUDE.md");
  const current = await readIfPresent(target);
  if (current !== undefined && !current.startsWith(REPOSITORY_INSTRUCTIONS_MARKER)) {
    if (rootDir === undefined) return undefined;
    throw new Error(
      `$HOME/.claude/CLAUDE.md already exists and was not written by Centaur; remove it or set repository_instructions: {enabled: false}`,
    );
  }
  await rm(target, { force: true });
  if (rootDir === undefined) return undefined;
  for (const name of REPOSITORY_GUIDES) {
    const text = await readIfPresent(join(rootDir, name));
    if (text === undefined) continue;
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) {
      throw new Error(
        `${name} is ${bytes} bytes, over repository_instructions.max_bytes (${maxBytes}); shorten it or raise the limit`,
      );
    }
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(target, `${REPOSITORY_INSTRUCTIONS_MARKER}\n${text}`);
    return name;
  }
  return undefined;
}
