import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CentaurConfig, parseCentaurConfig } from "../../src/config/index.js";
import { readConfigText } from "../../src/workflows/config-file.js";
import { installRepositoryInstructions } from "../../src/workflows/repository-instructions.js";

export const SELF_ROOT = "apps/centaur-test";
export const SELF_ROOT_2 = "apps/centaur-test-2";
export const SELF_ROOT_DEV = "apps/centaur-dev";
export const SELF_ROOTS = [SELF_ROOT, SELF_ROOT_2, SELF_ROOT_DEV] as const;
export const selfPath = (file: string, root = SELF_ROOT) => join(root, file);

export async function loadSelfConfig(root = SELF_ROOT) {
  const result = parseCentaurConfig(await readConfigText(".", root));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

export async function installSelfInstructions(root: string, config: CentaurConfig) {
  const home = await mkdtemp(join(tmpdir(), "centaur-self-home-"));
  try {
    return await installRepositoryInstructions({
      home,
      repoDir: ".",
      rootDir: root,
      maxBytes: config.repository_instructions.max_bytes,
      includeRepoRoot: config.repository_instructions.include_repo_root,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
