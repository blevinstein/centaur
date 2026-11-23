import type { Platform } from "../config/index.js";
import { scopedChatPrefix } from "../lambda/connection-paths.js";
import { type Destination, parseDestination } from "../lambda/destinations.js";
import type { ParameterStore } from "./parameter-store.js";

/** Every destination of a connection's platform, keyed by parameter name. */
export async function knownDestinations(
  store: ParameterStore,
  platform: Platform,
): Promise<Record<string, Destination>> {
  const names = await store.listNames(`${scopedChatPrefix(platform)}/`);
  const entries = await Promise.all(
    names.map(async (name) => [name, parseDestination((await store.get(name)) ?? "")] as const),
  );
  return Object.fromEntries(entries);
}
