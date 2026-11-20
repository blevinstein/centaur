import type { StateAdapter } from "chat";
import { checkMcpPolicy, formatIssues, parseCentaurConfig } from "../config/index.js";
import type { OidcVerifier } from "./oidc.js";
import {
  GLOBAL_MCP_POLICY_PARAMETER,
  mcpPolicyParameter,
  type ParameterStore,
} from "./parameters.js";
import { loadBotBinding, repoParameter, writeRegistryEntry } from "./registry.js";
import type { TelegramApi } from "./telegram.js";

export interface RegisterDeps {
  params: ParameterStore;
  registryState: StateAdapter;
  oidc: OidcVerifier;
  telegram: TelegramApi;
  functionUrl: string;
}

export interface RegisterRequest {
  token: string;
  config: string;
}

export const webhookUrl = (functionUrl: string, platform: string, bot: string) =>
  `${functionUrl.replace(/\/+$/, "")}/${platform}/${bot}`;

export function createRegister({
  params,
  registryState,
  oidc,
  telegram,
  functionUrl,
}: RegisterDeps) {
  return async ({ token, config: configText }: RegisterRequest) => {
    const { repository } = await oidc.verify(token);
    const parsed = parseCentaurConfig(configText);
    if (!parsed.ok) throw new Error(`invalid .centaur.yml:\n${formatIssues(parsed.issues)}`);
    const { bot, platform, respond_to, mcp_servers } = parsed.config;

    const { secrets, repo: boundRepo } = await loadBotBinding(params, bot);
    if (!secrets) {
      throw new Error(`bot "${bot}" has no secrets in SSM; run "centaur bot add" first`);
    }
    if (secrets.platform !== platform) {
      throw new Error(`bot "${bot}" is a ${secrets.platform} bot, not ${platform}`);
    }
    if (Object.keys(mcp_servers).length > 0) {
      const issues = checkMcpPolicy(bot, mcp_servers, {
        global: await params.get(GLOBAL_MCP_POLICY_PARAMETER),
        bot: await params.get(mcpPolicyParameter(bot)),
      });
      if (issues.length > 0) {
        throw new Error(`mcp_servers violate the operator policy:\n${formatIssues(issues)}`);
      }
    }

    // The conditional create makes the first binding atomic: a concurrent registration that lost
    // the race re-reads the winner's repo and is refused like any other non-owner.
    const owner =
      boundRepo ??
      ((await params.putIfAbsent(repoParameter(bot), repository))
        ? repository
        : await params.get(repoParameter(bot)));
    if (owner !== repository) {
      throw new Error(`bot "${bot}" is bound to ${owner}; run "centaur bot unbind" first`);
    }

    await writeRegistryEntry(registryState, bot, { respond_to });
    if (platform === "telegram") {
      await telegram.setWebhook(
        secrets.token,
        webhookUrl(functionUrl, platform, bot),
        secrets.webhookSecret,
      );
    }
    return { bot, repo: repository };
  };
}
