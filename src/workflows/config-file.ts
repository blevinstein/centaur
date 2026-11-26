import { access, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path";
import {
  type CentaurConfig,
  formatIssues,
  isRepoRelativePath,
  parseCentaurConfig,
} from "../config/index.js";
import { type Exec, execCommand } from "./aws.js";

export const CONFIG_FILES = [".centaur/config.yml", ".centaur.yml"] as const;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const configFilesIn = async (dir: string) =>
  (
    await Promise.all(
      CONFIG_FILES.map(async (file) => ((await exists(join(dir, file))) ? file : "")),
    )
  ).filter(Boolean);

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * The directory under `base` that holds the Centaur files. `root` is a path relative to `base`
 * (default `.`); it must stay inside `base`, including through symlinks.
 */
export async function resolveRoot(base: string, root = "."): Promise<string> {
  if (!isRepoRelativePath(root)) {
    throw new Error(`Invalid Centaur root "${root}": must be a relative path inside the repo`);
  }
  const dir = join(base, root);
  const [realBase, realDir] = await Promise.all([realpath(base), realpath(dir)]).catch(() => {
    throw new Error(`Centaur root "${root}" does not exist in ${base}`);
  });
  const rel = relative(realBase, realDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Centaur root "${root}" resolves outside ${base}`);
  }
  return dir;
}

/** Finds the one config file under `root` (relative to `base`); having both or neither is an error. */
export async function findConfigFile(base: string, root = "."): Promise<string> {
  const dir = await resolveRoot(base, root);
  const found = await configFilesIn(dir);
  if (found.length > 1) {
    throw new Error(
      `Found both ${CONFIG_FILES.join(" and ")} in ${dir}; remove one so the Centaur config lives in a single file`,
    );
  }
  if (!found[0]) {
    throw new Error(`No Centaur config in ${dir}: expected ${CONFIG_FILES.join(" or ")}`);
  }
  return join(dir, found[0]);
}

const configPathsIn = async (dir: string) =>
  (await configFilesIn(dir)).map((file) => join(dir, file));

async function configsBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const children = entries
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => join(dir, e.name));
  const found = await Promise.all(
    children.map(async (child) => [
      ...(await configPathsIn(child)),
      ...(await configsBelow(child)),
    ]),
  );
  return found.flat();
}

/** A repo uses one root config or sub-folder configs, never both. */
export async function assertSingleConfigStyle(base: string, root = "."): Promise<void> {
  const dir = await resolveRoot(base, root);
  const top = await configPathsIn(base);
  const other = relative(base, dir) === "" ? await configsBelow(base) : await configPathsIn(dir);
  if (top.length > 0 && other.length > 0) {
    throw new Error(
      `Found a Centaur config at the repo root (${top[0]}) and in a sub-folder (${other[0]}); use either one root config or sub-folder configs, not both`,
    );
  }
}

/** The repository root a config file at `path` belongs to; the MCP policy and other paths are relative to it. */
export function configRepoRoot(path: string): string {
  const dir = dirname(path);
  return basename(dir) === ".centaur" && basename(path) === "config.yml" ? dirname(dir) : dir;
}

export async function readConfigText(base: string, root = ".") {
  return readFile(await findConfigFile(base, root), "utf8");
}

export function parseConfigOrThrow(text: string): CentaurConfig {
  const result = parseCentaurConfig(text);
  if (!result.ok) throw new Error(`The Centaur config is invalid:\n${formatIssues(result.issues)}`);
  return result.config;
}

const inGitRepository = (base: string, exec: Exec) =>
  exec("git", ["-C", base, "rev-parse", "--git-dir"]).then(
    () => true,
    () => false,
  );

const committedConfigText = async (base: string, root: string, exec: Exec) => {
  if (!isRepoRelativePath(root)) throw new Error(`Invalid Centaur root "${root}"`);
  const texts = await Promise.all(
    CONFIG_FILES.map((file) =>
      exec("git", ["-C", base, "show", `HEAD:./${posix.join(root, file)}`]).catch(() => undefined),
    ),
  );
  const found = texts.filter((text) => text !== undefined);
  if (found.length !== 1) throw new Error("no single committed Centaur config");
  return found[0] as string;
};

/**
 * The execution mode of the config as committed at the checkout's HEAD, which the agent cannot
 * edit during a turn. Only outside a git repository is the file read. A committed config that is
 * missing, ambiguous or invalid yields `pull_request`, never `direct`.
 */
export async function committedExecutionMode(
  base: string,
  root = ".",
  exec: Exec = execCommand,
): Promise<CentaurConfig["execution"]["mode"]> {
  try {
    const text = (await inGitRepository(base, exec))
      ? await committedConfigText(base, root, exec)
      : await readConfigText(base, root);
    return parseConfigOrThrow(text).execution.mode;
  } catch {
    return "pull_request";
  }
}
