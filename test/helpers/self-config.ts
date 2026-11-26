import { join } from "node:path";
import { parseCentaurConfig } from "../../src/config/index.js";
import { readConfigText } from "../../src/workflows/config-file.js";

export const SELF_ROOT = "apps/centaur-test";
export const selfPath = (file: string) => join(SELF_ROOT, file);

export async function loadSelfConfig() {
  const result = parseCentaurConfig(await readConfigText(".", SELF_ROOT));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}
