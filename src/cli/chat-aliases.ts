import { CHATS_PREFIX } from "../lambda/parameters.js";
import type { ParameterStore } from "./parameter-store.js";

export async function knownChatAliases(store: ParameterStore): Promise<Record<string, string>> {
  const names = await store.listNames(`${CHATS_PREFIX}/`);
  const entries = await Promise.all(
    names.map(async (name) => [name, (await store.get(name)) ?? ""] as const),
  );
  return Object.fromEntries(entries);
}
