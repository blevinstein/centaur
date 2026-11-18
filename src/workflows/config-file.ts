import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CentaurConfig, formatIssues, parseCentaurConfig } from "../config/index.js";

export const CONFIG_FILE = ".centaur.yml";

export async function readConfigText(workspace: string) {
  return readFile(join(workspace, CONFIG_FILE), "utf8");
}

export function parseConfigOrThrow(text: string): CentaurConfig {
  const result = parseCentaurConfig(text);
  if (!result.ok) throw new Error(`${CONFIG_FILE} is invalid:\n${formatIssues(result.issues)}`);
  return result.config;
}
