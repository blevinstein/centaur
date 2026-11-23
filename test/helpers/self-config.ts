import { parseCentaurConfig } from "../../src/config/index.js";
import { readConfigText } from "../../src/workflows/config-file.js";

export async function loadSelfConfig() {
  const result = parseCentaurConfig(await readConfigText("."));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}
