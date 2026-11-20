import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const BUNDLED_MCP_POLICY_FILE = "mcp-policy.cedar";

export type McpPolicyReader = () => Promise<string | undefined>;

/** Reads the global operator policy that `scripts/deploy.sh` zips next to the handler, if any. */
export const readBundledMcpPolicy =
  (location = new URL(BUNDLED_MCP_POLICY_FILE, import.meta.url)): McpPolicyReader =>
  async () => {
    try {
      return await readFile(fileURLToPath(location), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
