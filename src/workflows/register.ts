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

export function oidcTokenFetcher(env: NodeJS.ProcessEnv, audience: string) {
  return async () => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) throw new Error("GitHub OIDC is unavailable; grant `id-token: write`");
    const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) throw new Error(`OIDC token request failed (${response.status})`);
    return ((await response.json()) as { value: string }).value;
  };
}
