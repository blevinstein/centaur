import type { PosterClient } from "./aws.js";
import { parseConfigOrThrow, readConfigText } from "./config-file.js";
import { enforceMcpPolicy, type McpPolicyDeps } from "./mcp-policy-check.js";

export interface RegisterDeps {
  workspace: string;
  mcpPolicy?: McpPolicyDeps | undefined;
  poster: PosterClient;
  fetchToken: () => Promise<string>;
  mask: (value: string) => void;
}

export async function registerRepo({
  workspace,
  mcpPolicy,
  poster,
  fetchToken,
  mask,
}: RegisterDeps) {
  const config = await readConfigText(workspace);
  await enforceMcpPolicy(parseConfigOrThrow(config), mcpPolicy);
  const token = await fetchToken();
  mask(token);
  return poster.call<{ bot: string; repo: string }>({ operation: "register", token, config });
}
