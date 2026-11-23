import type { Platform } from "../config/index.js";
import { scopedChatPrefix } from "../lambda/connection-paths.js";
import type { ParameterStore } from "./parameter-store.js";

export async function knownChatAliases(
  store: ParameterStore,
  platform: Platform,
): Promise<Record<string, string>> {
  const names = await store.listNames(`${scopedChatPrefix(platform)}/`);
  const entries = await Promise.all(
    names.map(async (name) => [name, (await store.get(name)) ?? ""] as const),
  );
  return Object.fromEntries(entries);
}
