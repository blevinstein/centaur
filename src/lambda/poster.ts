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
import {
  listThreadsRequestSchema,
  mcpApprovalsRequestSchema,
  readChannelRequestSchema,
  searchChatRequestSchema,
  UNREACT_MAX_MESSAGES,
} from "../poster-contract.js";
import { createAccessResolver } from "./access.js";
import type { AttachmentStore } from "./attachments.js";
import { createCallerCheck } from "./caller-check.js";
import { postInThread } from "./channel-history.js";
import { createChatContext, toChatMessage } from "./chat-context.js";
import type { RepositoryDispatcher } from "./github.js";
import { createMcpApprovals } from "./mcp-approvals.js";
import type { McpPolicyReader } from "./mcp-policy.js";
import type { OidcVerifier } from "./oidc.js";
import type { ThreadMetadata } from "./ownership.js";
import type { ParameterStore } from "./parameters.js";
import { createPullRequests } from "./pull-requests.js";
import { createRegister } from "./register.js";
import { type Bot, botStatePrefix, requireBot, requireBound } from "./registry.js";
import { createSearchChat } from "./search-chat.js";
import { createSelfIdentityLookup } from "./self-identity.js";
import { createSlackSearchApi, type SlackSearchApi } from "./slack-search.js";
import { connectState } from "./state.js";
import type { TelegramApi } from "./telegram.js";
import { createThreadMeta } from "./thread-meta.js";
import { createThreadStarter, TOPIC_NAME_MAX } from "./thread-starter.js";

const text = z.string().min(1);
const threadId = z.string().min(1);
const pullRequest = z.number().int().positive();
/** Required by the poster only when `REQUIRE_POSTER_TOKEN` is on; verified whenever present. */
const optionalToken = z.string().min(1).optional();

export const posterRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("post"), token: optionalToken, bot: slug, threadId, text }),
  z
    .strictObject({
      operation: z.literal("start-thread"),
      token: optionalToken,
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
    token: optionalToken,
    bot: slug,
    threadId,
    messageIds: z.array(z.string().min(1)).min(1).max(UNREACT_MAX_MESSAGES),
  }),
  z.strictObject({ operation: z.literal("get-mcp-policy"), token: optionalToken, bot: slug }),
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
  mcpApprovalsRequestSchema,
  listThreadsRequestSchema,
  readChannelRequestSchema,
  searchChatRequestSchema,
]);

export type PosterRequest = z.input<typeof posterRequestSchema>;

export type PosterChat = Pick<
  Chat<Record<string, Adapter>, ThreadMetadata>,
  "initialize" | "thread" | "channel" | "history" | "openDM"
>;

export interface PosterDeps {
  params: ParameterStore;
  createState: (keyPrefix: string) => StateAdapter;
  chatFor: (bot: Bot, botState: StateAdapter) => PosterChat;
  attachments: AttachmentStore;
  telegram: TelegramApi;
  /** Defaults to the real Slack Web API. */
  searchSlack?: SlackSearchApi;
  oidc: OidcVerifier;
  requirePosterToken: boolean;
  dispatcher: RepositoryDispatcher;
  globalMcpPolicy: McpPolicyReader;
  functionUrl: string;
  logger: Pick<Logger, "info" | "warn" | "error">;
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

  const requireCaller = createCallerCheck({
    params,
    oidc: deps.oidc,
    required: deps.requirePosterToken,
    logger,
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

  const searchChat = createSearchChat({
    target: chatContext.target,
    searchSlack: deps.searchSlack ?? createSlackSearchApi(),
    logger,
  });

  const lookupIdentity = createSelfIdentityLookup({ telegram, logger });
  const mcpApprovals = createMcpApprovals({
    params,
    oidc: deps.oidc,
    open: async (botName, threadId) => {
      const { bot, chat, state } = await openThreadChat(botName, threadId);
      const adapter = chat.thread(threadId).adapter;
      return {
        bot,
        messenger: chat,
        state,
        adapter,
        identify: () => lookupIdentity(bot, adapter),
      };
    },
    openBotState: (botName) => stateFor(botStatePrefix(botName)),
    dispatcher: deps.dispatcher,
    logger,
  });

  const threadStarter = createThreadStarter({
    params,
    logger,
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
        await requireCaller({ ...request, allowUnbound: true });
        return { policy: (await deps.globalMcpPolicy()) ?? null };
      case "link-pull-request":
        return pullRequests.link(request);
      case "resolve-pull-request":
        return pullRequests.resolve(request);
      case "mcp-approvals":
        return mcpApprovals(request);
      case "list-threads":
        return chatContext.listThreads(request);
      case "read-channel":
        return chatContext.readChannel(request);
      case "search-chat":
        return searchChat(request);
      case "post": {
        await requireCaller(request);
        const { bot, chat } = await openThreadChat(request.bot, request.threadId);
        const sent = await postInThread(
          { chat, botName: bot.name, logger },
          request.threadId,
          request.text,
        );
        return { messageId: sent.id };
      }
      case "start-thread":
        await requireCaller(request);
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
          messages.push(toChatMessage(message, await storedAttachments(message)));
        }
        const policy = (await threadMeta.read(request.threadId))?.context;
        return { messages, ...(policy ? { policy } : {}) };
      }
      case "unreact": {
        await requireCaller(request);
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
