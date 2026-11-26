import { join } from "node:path";
import { parseCentaurConfig } from "../../src/config/index.js";
import { readConfigText } from "../../src/workflows/config-file.js";

export const SELF_ROOT = "apps/centaur-test";
export const SELF_ROOT_2 = "apps/centaur-test-2";
export const selfPath = (file: string, root = SELF_ROOT) => join(root, file);

export async function loadSelfConfig(root = SELF_ROOT) {
  const result = parseCentaurConfig(await readConfigText(".", root));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}
