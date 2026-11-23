import { type Adapter, type Chat, emoji, type Logger, type Message, type StateAdapter } from "chat";
import { z } from "zod";
import {
  CONTEXT_POLICIES,
  PLATFORMS,
  type Platform,
  slug,
  THREAD_MODES,
  threadPlatform,
} from "../config/index.js";
import { createAccessResolver } from "./access.js";
import type { AttachmentStore } from "./attachments.js";
import {
  createChatContext,
  listThreadsRequestSchema,
  readChannelRequestSchema,
} from "./chat-context.js";
import type { McpPolicyReader } from "./mcp-policy.js";
import type { OidcVerifier } from "./oidc.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import { createPullRequests } from "./pull-requests.js";
import { createRegister } from "./register.js";
import { type Bot, botStatePrefix, requireBot, requireBound } from "./registry.js";
import { connectState } from "./state.js";
import type { TelegramApi } from "./telegram.js";
import { createThreadMeta } from "./thread-meta.js";
import { createThreadStarter, TOPIC_NAME_MAX } from "./thread-starter.js";

export const UNREACT_MAX_MESSAGES = 50;

const text = z.string().min(1);
const threadId = z.string().min(1);
const pullRequest = z.number().int().positive();

export const posterRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("post"), bot: slug, threadId, text }),
  z
    .strictObject({
      operation: z.literal("start-thread"),
      bot: slug,
      text,
      title: z.string().min(1).max(TOPIC_NAME_MAX).optional(),
      destination: slug.optional(),
      /** Selects the connection of a `destination`; optional on a single-connection bot. */
      platform: z.enum(PLATFORMS).optional(),
      fromThreadId: threadId.optional(),
      /** The prompt's context policy, stored on the new thread for its replies. */
      context: z.enum(CONTEXT_POLICIES).optional(),
      /** `new` always opens a fresh thread; `persistent` posts into the destination's bound thread. */
      thread: z.enum(THREAD_MODES).optional(),
    })
    .refine(
      (request) => (request.destination === undefined) !== (request.fromThreadId === undefined),
      {
        message: "start-thread needs exactly one of destination and fromThreadId",
      },
    )
    .refine((request) => request.fromThreadId === undefined || request.platform === undefined, {
      message: "start-thread takes platform only with destination; fromThreadId implies it",
    })
    .refine((request) => request.fromThreadId === undefined || request.thread === undefined, {
      message: "start-thread takes thread only with destination",
    }),
  z.strictObject({
    operation: z.literal("resolve-destination"),
    token: z.string().min(1),
    bot: slug,
    platform: z.enum(PLATFORMS).optional(),
    name: slug,
    thread: z.enum(THREAD_MODES).optional(),
  }),
  z.strictObject({
    operation: z.literal("read"),
    token: z.string().min(1),
    bot: slug,
    threadId,
    /** Drops messages the chat tools may not show (see `visibleTo`); requires an approved chat. */
    visibleOnly: z.boolean().optional(),
  }),
  z.strictObject({
    operation: z.literal("unreact"),
    bot: slug,
    threadId,
    messageIds: z.array(z.string().min(1)).min(1).max(UNREACT_MAX_MESSAGES),
  }),
  z.strictObject({ operation: z.literal("get-mcp-policy") }),
  z.strictObject({ operation: z.literal("register"), token: z.string().min(1), config: text }),
  z.strictObject({
    operation: z.literal("link-pull-request"),
    token: z.string().min(1),
    bot: slug,
    threadId,
    pullRequest,
  }),
  z.strictObject({
    operation: z.literal("resolve-pull-request"),
    token: z.string().min(1),
    pullRequest,
    withThreadId: z.boolean().optional(),
  }),
  listThreadsRequestSchema,
  readChannelRequestSchema,
]);

export type PosterRequest = z.input<typeof posterRequestSchema>;

export type PosterChat = Pick<
  Chat<Record<string, Adapter>, ThreadMetadata>,
  "initialize" | "thread" | "channel"
>;

export interface PosterDeps {
  params: ParameterStore;
  createState: (keyPrefix: string) => StateAdapter;
  chatFor: (bot: Bot, botState: StateAdapter) => PosterChat;
  attachments: AttachmentStore;
  telegram: TelegramApi;
  oidc: OidcVerifier;
  globalMcpPolicy: McpPolicyReader;
  functionUrl: string;
  logger: Pick<Logger, "warn">;
}

export async function createPoster(deps: PosterDeps) {
  const { params, createState, chatFor, attachments, telegram, logger } = deps;
  const states = new Map<string, Promise<StateAdapter>>();
  const stateFor = (keyPrefix: string) => {
    let state = states.get(keyPrefix);
    if (!state) {
      state = connectState(createState(keyPrefix)).catch((error) => {
        states.delete(keyPrefix);
        throw error;
      });
      states.set(keyPrefix, state);
    }
    return state;
  };
  const registryState = await stateFor("");
  const register = createRegister({
    params,
    registryState,
    oidc: deps.oidc,
    telegram,
    functionUrl: deps.functionUrl,
  });

  const pullRequests = createPullRequests({
    params,
    state: registryState,
    oidc: deps.oidc,
  });

  const loadBot = (botName: string, platform?: Platform) =>
    requireBot(params, botName, { logger, ...(platform ? { platform } : {}) });

  const openChat = async (botName: string, platform?: Platform) => {
    const bot = await loadBot(botName, platform);
    const botState = await stateFor(botStatePrefix(bot.name));
    const chat = chatFor(bot, botState);
    await chat.initialize();
    return { bot, chat, threadMeta: createThreadMeta(botState), state: botState };
  };

  const openThreadChat = (botName: string, threadId: string) =>
    openChat(botName, threadPlatform(threadId));

  const requireApprovedChat = async (bot: Bot, chatId: string, name = chatId) => {
    const access = await createAccessResolver(bot, params)();
    if (access.blockedChatIds.has(chatId)) {
      throw new Error(`chat ${name} is blocked for bot "${bot.name}"`);
    }
    if (!access.chatIds.has(chatId)) {
      throw new Error(
        `chat ${name} is not approved for bot "${bot.name}"; the maintainer must approve it with \`centaur access approve ${bot.name} chat ${chatId}\``,
      );
    }
    return access;
  };

  const chatContext = createChatContext({
    params,
    oidc: deps.oidc,
    openThreadChat,
    requireApprovedChat,
    logger,
  });

  const threadStarter = createThreadStarter({
    params,
    telegram,
    loadBot,
    openChat,
    requireApprovedChat,
  });

  return async (rawRequest: unknown) => {
    const request = posterRequestSchema.parse(rawRequest);
    switch (request.operation) {
      case "register":
        return register(request);
      case "get-mcp-policy":
        return { policy: (await deps.globalMcpPolicy()) ?? null };
      case "link-pull-request":
        return pullRequests.link(request);
      case "resolve-pull-request":
        return pullRequests.resolve(request);
      case "list-threads":
        return chatContext.listThreads(request);
      case "read-channel":
        return chatContext.readChannel(request);
      case "post": {
        const { chat } = await openThreadChat(request.bot, request.threadId);
        const sent = await chat.thread(request.threadId).post(request.text);
        return { messageId: sent.id };
      }
      case "start-thread":
        return threadStarter.start(request);
      case "resolve-destination": {
        await requireBound(params, deps.oidc, request.token, request.bot);
        return threadStarter.resolve(request);
      }
      case "read": {
        await requireBound(params, deps.oidc, request.token, request.bot);
        const { chat, threadMeta } = await openThreadChat(request.bot, request.threadId);
        const visible = request.visibleOnly
          ? await chatContext.visibleInThread(request.bot, request.threadId)
          : undefined;
        const thread = chat.thread(request.threadId);
        const attachmentsOf = await attachments.forThread(request.bot, request.threadId);
        const storedAttachments = async (message: Message) => {
          const stored = attachmentsOf(message.id);
          if (stored.length > 0 || message.attachments.length === 0) return stored;
          message.attachments = message.attachments.map((attachment) =>
            attachment.fetchData
              ? attachment
              : (thread.adapter.rehydrateAttachment?.(attachment) ?? attachment),
          );
          try {
            return await attachments.save(request.bot, message);
          } catch (error) {
            logger.warn("failed to store attachments", {
              bot: request.bot,
              threadId: request.threadId,
              messageId: message.id,
              error,
            });
            return [];
          }
        };
        const messages = [];
        for await (const message of thread.allMessages) {
          if (visible && !visible(message)) continue;
          messages.push({
            id: message.id,
            userId: message.author.userId,
            userName: message.author.userName,
            fromBot: message.author.isMe,
            text: message.text,
            attachments: await storedAttachments(message),
            sentAt: message.metadata.dateSent.toISOString(),
          });
        }
        const policy = (await threadMeta.read(request.threadId))?.context;
        return { messages, ...(policy ? { policy } : {}) };
      }
      case "unreact": {
        const { bot, chat } = await openThreadChat(request.bot, request.threadId);
        const thread = chat.thread(request.threadId);
        const results = [];
        for (const messageId of request.messageIds) {
          try {
            await thread.adapter.removeReaction(thread.id, messageId, emoji.eyes);
            results.push({ messageId, removed: true });
          } catch (error) {
            logger.warn("failed to remove reaction", {
              bot: bot.name,
              threadId: request.threadId,
              messageId,
              error,
            });
            results.push({ messageId, removed: false });
          }
        }
        return { results };
      }
    }
  };
}
