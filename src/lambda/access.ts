import type { StateAdapter } from "chat";
import { chatParameter, type ParameterStore, userParameter } from "./parameters.js";
import { type Bot, readRegistryEntry } from "./registry.js";

export interface Access {
  userIds: Set<string>;
  chatIds: Set<string>;
}

export type AccessResolver = () => Promise<Access>;

export function createAccessResolver(
  bot: Bot,
  params: ParameterStore,
  registryState: StateAdapter,
): AccessResolver {
  const lookup = async (names: string[]) => {
    const values = await Promise.all(names.map((name) => params.get(name)));
    return new Set(values.filter((id): id is string => id !== undefined));
  };
  return async () => {
    const entry = await readRegistryEntry(registryState, bot.name);
    return {
      userIds: await lookup((entry?.allow ?? []).map((name) => userParameter(name, bot.platform))),
      chatIds: await lookup(entry?.destination ? [chatParameter(entry.destination)] : []),
    };
  };
}
