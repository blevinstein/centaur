import type { StateAdapter } from "chat";
import { type CentaurConfig, PLATFORMS, type Platform, type RespondTo } from "../config/index.js";
import { botParameter, PARAMETER_ROOT, type ParameterStore } from "./parameters.js";

export interface Bot {
  name: string;
  platform: Platform;
  repo: string;
  token: string;
  webhookSecret: string;
}

export type BotSecrets = Omit<Bot, "repo">;

export type RegistryEntry = Pick<CentaurConfig, "allow" | "destination"> & {
  respond_to?: RespondTo;
};

const WEBHOOK_SECRET_KEY: Record<Platform, string> = {
  telegram: "webhook-secret",
  slack: "signing-secret",
};

const BOT_PARAMETER = new RegExp(`^${PARAMETER_ROOT}/bots/([^/]+)/([^/]+)$`);

export const registryKey = (bot: string) => `registry:${bot}`;
export const botStatePrefix = (bot: string) => `bot:${bot}:`;
export const repoParameter = (bot: string) => botParameter(bot, "repo");

function secretsOf(name: string, found: Record<string, string>): BotSecrets | undefined {
  const platform = PLATFORMS.find((candidate) => candidate === found.platform);
  const webhookSecret = platform && found[WEBHOOK_SECRET_KEY[platform]];
  const { token } = found;
  return platform && webhookSecret && token ? { name, platform, token, webhookSecret } : undefined;
}

const withRepo = (name: string, found: Record<string, string>): Bot | undefined => {
  const secrets = secretsOf(name, found);
  return secrets && found.repo ? { ...secrets, repo: found.repo } : undefined;
};

function groupByBot(entries: Record<string, string>) {
  const byBot = new Map<string, Record<string, string>>();
  for (const [name, value] of Object.entries(entries)) {
    const [, bot, key] = BOT_PARAMETER.exec(name) ?? [];
    if (bot && key) byBot.set(bot, { ...byBot.get(bot), [key]: value });
  }
  return byBot;
}

export async function loadBots(params: ParameterStore): Promise<Bot[]> {
  const byBot = groupByBot(await params.getByPath(`${PARAMETER_ROOT}/bots`));
  return [...byBot].flatMap(([name, found]) => withRepo(name, found) ?? []);
}

export async function loadBot(params: ParameterStore, name: string): Promise<Bot | undefined> {
  const found = groupByBot(await params.getByPath(`${PARAMETER_ROOT}/bots/${name}`)).get(name);
  return found && withRepo(name, found);
}

export async function loadBotBinding(
  params: ParameterStore,
  name: string,
): Promise<{ secrets: BotSecrets | undefined; repo: string | undefined }> {
  const found =
    groupByBot(await params.getByPath(`${PARAMETER_ROOT}/bots/${name}`)).get(name) ?? {};
  return { secrets: secretsOf(name, found), repo: found.repo };
}

export async function readRegistryEntry(
  state: StateAdapter,
  bot: string,
): Promise<RegistryEntry | null> {
  return state.get<RegistryEntry>(registryKey(bot));
}

export async function readRespondTo(state: StateAdapter, bot: string): Promise<RespondTo> {
  return (await readRegistryEntry(state, bot))?.respond_to ?? "mention";
}

export async function writeRegistryEntry(
  state: StateAdapter,
  bot: string,
  entry: RegistryEntry,
): Promise<void> {
  await state.set(registryKey(bot), entry);
}
