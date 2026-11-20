import { access, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type CentaurConfig, formatIssues, parseCentaurConfig } from "../config/index.js";

export const CONFIG_FILES = [".centaur/config.yml", ".centaur.yml"] as const;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Finds the one config file under `root`; having both or neither is an error. */
export async function findConfigFile(root: string): Promise<string> {
  const found = (
    await Promise.all(
      CONFIG_FILES.map(async (file) => ((await exists(join(root, file))) ? file : "")),
    )
  ).filter(Boolean);
  if (found.length > 1) {
    throw new Error(
      `Found both ${CONFIG_FILES.join(" and ")} in ${root}; remove one so the Centaur config lives in a single file`,
    );
  }
  if (!found[0]) {
    throw new Error(`No Centaur config in ${root}: expected ${CONFIG_FILES.join(" or ")}`);
  }
  return join(root, found[0]);
}

/** The repository root a config file at `path` belongs to; the MCP policy and other paths are relative to it. */
export function configRepoRoot(path: string): string {
  const dir = dirname(path);
  return basename(dir) === ".centaur" && basename(path) === "config.yml" ? dirname(dir) : dir;
}

export async function readConfigText(root: string) {
  return readFile(await findConfigFile(root), "utf8");
}

export function parseConfigOrThrow(text: string): CentaurConfig {
  const result = parseCentaurConfig(text);
  if (!result.ok) throw new Error(`The Centaur config is invalid:\n${formatIssues(result.issues)}`);
  return result.config;
}
