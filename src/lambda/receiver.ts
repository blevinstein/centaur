import type { Logger, StateAdapter } from "chat";
import type { AttachmentStore } from "./attachments.js";
import { createBotChat } from "./chat.js";
import type { RepositoryDispatcher } from "./github.js";
import type { WebHandler } from "./http.js";
import type { ParameterStore } from "./parameters.js";
import { type Bot, botStatePrefix, loadBots } from "./registry.js";
import { connectState } from "./state.js";

export interface ReceiverDeps {
  params: ParameterStore;
  createState: (keyPrefix: string) => StateAdapter;
  attachments: AttachmentStore;
  dispatcher: RepositoryDispatcher;
  logger: Logger;
}

const ROUTE = /^\/(telegram|slack)\/([a-z0-9][a-z0-9_-]*)$/;

export const routeKey = (bot: Pick<Bot, "platform" | "name">) => `/${bot.platform}/${bot.name}`;

export async function createReceiver({
  params,
  createState,
  attachments,
  dispatcher,
  logger,
}: ReceiverDeps): Promise<WebHandler> {
  const registryState = await connectState(createState(""));
  const routes = new Map(
    await Promise.all(
      (await loadBots(params)).map(async (bot) => {
        const chat = createBotChat({
          bot,
          params,
          registryState,
          botState: await connectState(createState(botStatePrefix(bot.name))),
          attachments,
          dispatcher,
          logger,
        });
        return [routeKey(bot), { bot, chat }] as const;
      }),
    ),
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
    for (let drained = 0; drained < tasks.length; ) {
      const pending = tasks.slice(drained);
      drained = tasks.length;
      await Promise.allSettled(pending);
    }
    return response;
  };
}
