import type { StateAdapter } from "chat";
import { chatParameter, type ParameterStore, userParameter } from "./parameters.js";
import { type Bot, type RegistryEntry, readRegistryEntry, registeredChats } from "./registry.js";

export interface Access {
  userIds: Set<string>;
  chatIds: Set<string>;
}

export type AccessResolver = () => Promise<Access>;

async function lookup(params: ParameterStore, names: string[]) {
  const values = await Promise.all(names.map((name) => params.get(name)));
  return new Set(values.filter((id): id is string => id !== undefined));
}

export const registeredChatIds = (params: ParameterStore, entry: RegistryEntry | null) =>
  lookup(params, registeredChats(entry).map(chatParameter));

export function createAccessResolver(
  bot: Bot,
  params: ParameterStore,
  registryState: StateAdapter,
): AccessResolver {
  return async () => {
    const entry = await readRegistryEntry(registryState, bot.name);
    return {
      userIds: await lookup(
        params,
        (entry?.allow ?? []).map((name) => userParameter(name, bot.platform)),
      ),
      chatIds: await registeredChatIds(params, entry),
    };
  };
}
