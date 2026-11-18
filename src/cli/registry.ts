import type { ParameterStore } from "./parameter-store.js";

export class CliError extends Error {}

export const PLATFORMS = {
  telegram: { prompted: ["token"], generated: ["webhook-secret"] },
  slack: { prompted: ["token", "signing-secret"], generated: [] },
} as const satisfies Record<string, { prompted: readonly string[]; generated: readonly string[] }>;

export type Platform = keyof typeof PLATFORMS;

export const PLATFORM_NAMES = Object.keys(PLATFORMS) as Platform[];

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function parseName(kind: string, value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new CliError(`Invalid ${kind} name "${value}": use lowercase letters, digits, and "-".`);
  }
  return value;
}

export function parsePlatform(value: string): Platform {
  if (!PLATFORM_NAMES.includes(value as Platform)) {
    throw new CliError(
      `Unknown platform "${value}": expected one of ${PLATFORM_NAMES.join(", ")}.`,
    );
  }
  return value as Platform;
}

export const botPrefix = (bot: string) => `/centaur/bots/${bot}/`;
export const botParameter = (bot: string, key: string) => `${botPrefix(bot)}${key}`;
export const userParameter = (user: string, platform: Platform) =>
  `/centaur/users/${user}/${platform}`;
export const chatParameter = (chat: string) => `/centaur/chats/${chat}`;

export async function requireBotPlatform(store: ParameterStore, bot: string): Promise<Platform> {
  const platform = await store.get(botParameter(bot, "platform"));
  if (!platform) throw new CliError(`Unknown bot "${bot}".`);
  return parsePlatform(platform);
}
