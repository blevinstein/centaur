import { ALIAS_PATTERN } from "../config/index.js";
import { chatParameter, GITHUB_TOKEN_PARAMETER } from "../lambda/parameters.js";
import type { ParameterStore } from "./parameter-store.js";

export { chatParameter, GITHUB_TOKEN_PARAMETER };

export class CliError extends Error {}

export const PLATFORMS = {
  telegram: { prompted: ["token"], generated: ["webhook-secret"] },
  slack: { prompted: ["token", "signing-secret"], generated: [] },
} as const satisfies Record<string, { prompted: readonly string[]; generated: readonly string[] }>;

export type Platform = keyof typeof PLATFORMS;

export const PLATFORM_NAMES = Object.keys(PLATFORMS) as Platform[];

export function parseName(kind: string, value: string): string {
  if (!ALIAS_PATTERN.test(value)) {
    throw new CliError(
      `Invalid ${kind} name "${value}": use lowercase letters, digits, "-" and "_".`,
    );
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

export function selectedPlatformIds(options: Record<string, string | boolean | undefined>) {
  const ids = PLATFORM_NAMES.flatMap((platform) => {
    const id = options[platform];
    return id ? [{ platform, id: String(id) }] : [];
  });
  if (ids.length === 0) {
    throw new CliError(`Pass at least one of ${PLATFORM_NAMES.map((p) => `--${p}`).join(", ")}.`);
  }
  return ids;
}

export const BOTS_PREFIX = "/centaur/bots/";
export const botPrefix = (bot: string) => `${BOTS_PREFIX}${bot}/`;
export const botParameter = (bot: string, key: string) => `${botPrefix(bot)}${key}`;

export async function requireBotPlatform(store: ParameterStore, bot: string): Promise<Platform> {
  const platform = await store.get(botParameter(bot, "platform"));
  if (!platform) throw new CliError(`Unknown bot "${bot}".`);
  return parsePlatform(platform);
}
