import type { Logger, StateAdapter } from "chat";
import { createBotChat } from "./chat.js";
import type { RepositoryDispatcher } from "./github.js";
import type { WebHandler } from "./http.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, loadBots } from "./registry.js";

export interface ReceiverDeps {
  params: ParameterStore;
  stateFor: (keyPrefix: string) => StateAdapter;
  dispatcher: RepositoryDispatcher;
  logger: Logger;
}

const ROUTE = /^\/(telegram|slack)\/([a-z0-9][a-z0-9_-]*)$/;

export const routeKey = (bot: Pick<Bot, "platform" | "name">) => `/${bot.platform}/${bot.name}`;

export async function createReceiver({
  params,
  stateFor,
  dispatcher,
  logger,
}: ReceiverDeps): Promise<WebHandler> {
  const registryState = stateFor("");
  const routes = new Map(
    (await loadBots(params)).map((bot) => {
      const chat = createBotChat({
        bot,
        params,
        registryState,
        botState: stateFor(`bot:${bot.name}:`),
        dispatcher,
        logger,
      });
      return [routeKey(bot), { bot, chat }] as const;
    }),
  );

  return async (request) => {
    const { pathname } = new URL(request.url);
    const route = ROUTE.test(pathname) ? routes.get(pathname) : undefined;
    const webhook = route?.chat.webhooks[route.bot.platform];
    if (!webhook || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const tasks: Promise<unknown>[] = [];
    const response = await webhook(request, {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.allSettled(tasks);
    return response;
  };
}
