import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** The repository guides, in order of preference. */
export const REPOSITORY_GUIDES = ["AGENTS.md", "CLAUDE.md"];

/** First line of the file this module writes; a `CLAUDE.md` without it is never touched. */
export const REPOSITORY_INSTRUCTIONS_MARKER =
  "<!-- centaur: repository instructions, rewritten every turn -->";

export interface RepositoryInstructionsInstall {
  home: string;
  /** The trusted checkout's top directory; the paths in the headings are relative to it. */
  repoDir: string;
  /** The trusted checkout's Centaur root; undefined removes the installed file. */
  rootDir: string | undefined;
  /** Cap on the guides' combined size. */
  maxBytes: number;
}

const readIfPresent = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

async function firstGuide(repoDir: string, dir: string) {
  for (const name of REPOSITORY_GUIDES) {
    const text = await readIfPresent(join(dir, name));
    if (text !== undefined) return { path: relative(repoDir, join(dir, name)), text };
  }
  return undefined;
}

/**
 * Makes `$HOME/.claude/CLAUDE.md`, the user memory Claude Code reads under `--setting-sources user`,
 * hold the trusted checkout's guides, each under a `# Instructions from <path>` heading: the first existing of
 * `AGENTS.md`, `CLAUDE.md` in the repository's top directory, then the same in the Centaur root when
 * that is a sub-folder. Returns the guides' paths. Removes the file it wrote earlier when there is
 * nothing to install. Throws, rather than truncate someone's rules, when the guides together exceed
 * `maxBytes`, and for a user memory it did not write.
 */
export async function installRepositoryInstructions({
  home,
  repoDir,
  rootDir,
  maxBytes,
}: RepositoryInstructionsInstall) {
  const target = join(home, ".claude", "CLAUDE.md");
  const current = await readIfPresent(target);
  if (current !== undefined && !current.startsWith(REPOSITORY_INSTRUCTIONS_MARKER)) {
    if (rootDir === undefined) return [];
    throw new Error(
      `$HOME/.claude/CLAUDE.md already exists and was not written by Centaur; remove it or set repository_instructions: {enabled: false}`,
    );
  }
  await rm(target, { force: true });
  if (rootDir === undefined) return [];
  const dirs = rootDir === repoDir ? [repoDir] : [repoDir, rootDir];
  const guides = (await Promise.all(dirs.map((dir) => firstGuide(repoDir, dir)))).filter(
    (guide) => guide !== undefined,
  );
  if (guides.length === 0) return [];
  const sizes = guides.map(({ text }) => Buffer.byteLength(text));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > maxBytes) {
    const parts = guides.map(({ path }, i) => `${path} is ${sizes[i]} bytes`).join(", ");
    throw new Error(
      `${parts}: ${total} bytes together, over repository_instructions.max_bytes (${maxBytes}); shorten them or raise the limit`,
    );
  }
  const body = guides
    .map(({ path, text }) => `# Instructions from ${path}\n\n${text}`)
    .join("\n\n");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(target, `${REPOSITORY_INSTRUCTIONS_MARKER}\n${body}`);
  return guides.map(({ path }) => path);
}
