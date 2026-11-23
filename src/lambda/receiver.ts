import type { Logger, StateAdapter } from "chat";
import type { AttachmentStore } from "./attachments.js";
import { createBotChat } from "./chat.js";
import type { RepositoryDispatcher } from "./github.js";
import type { HistoryWindow } from "./history-window.js";
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
  history?: HistoryWindow | undefined;
}

const ROUTE = /^\/(telegram|slack)\/([a-z0-9][a-z0-9_-]*)$/;

export const routeKey = (bot: Pick<Bot, "platform" | "name">) => `/${bot.platform}/${bot.name}`;

export async function createReceiver({
  params,
  createState,
  attachments,
  dispatcher,
  logger,
  history,
}: ReceiverDeps): Promise<WebHandler> {
  const registryState = await connectState(createState(""));
  const bots = await loadBots(params, logger);
  const connections = await Promise.all(
    bots.map(async (bot) => {
      try {
        const chat = createBotChat({
          bot,
          params,
          registryState,
          botState: await connectState(createState(botStatePrefix(bot.name))),
          attachments,
          dispatcher,
          logger,
          history,
        });
        return [routeKey(bot), { bot, chat }] as const;
      } catch (error) {
        logger.error("connection failed to start; not served", {
          bot: bot.name,
          platform: bot.platform,
          error,
        });
        return undefined;
      }
    }),
  );
  const routes = new Map(connections.filter((connection) => connection !== undefined));
  if (bots.length > 0 && routes.size === 0) {
    throw new Error("no connection could be started");
  }

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
