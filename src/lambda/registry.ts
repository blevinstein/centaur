import type { StateAdapter } from "chat";
import { type CentaurConfig, PLATFORMS, type Platform } from "../config/index.js";
import { PARAMETER_ROOT, type ParameterStore } from "./parameters.js";

export interface Bot {
  name: string;
  platform: Platform;
  repo: string;
  token: string;
  webhookSecret: string;
}

export type RegistryEntry = Pick<CentaurConfig, "allow" | "destination">;

const WEBHOOK_SECRET_KEY: Record<Platform, string> = {
  telegram: "webhook-secret",
  slack: "signing-secret",
};

const BOT_PARAMETER = new RegExp(`^${PARAMETER_ROOT}/bots/([^/]+)/([^/]+)$`);

export const registryKey = (bot: string) => `registry:${bot}`;

export async function loadBots(params: ParameterStore): Promise<Bot[]> {
  const byBot = new Map<string, Record<string, string>>();
  for (const [name, value] of Object.entries(await params.getByPath(`${PARAMETER_ROOT}/bots`))) {
    const [, bot, key] = BOT_PARAMETER.exec(name) ?? [];
    if (bot && key) byBot.set(bot, { ...byBot.get(bot), [key]: value });
  }
  return [...byBot].flatMap(([name, found]) => {
    const platform = PLATFORMS.find((candidate) => candidate === found.platform);
    const secret = platform && found[WEBHOOK_SECRET_KEY[platform]];
    const { repo, token } = found;
    return platform && secret && repo && token
      ? [{ name, platform, repo, token, webhookSecret: secret }]
      : [];
  });
}

export async function readRegistryEntry(
  state: StateAdapter,
  bot: string,
): Promise<RegistryEntry | null> {
  return state.get<RegistryEntry>(registryKey(bot));
}
