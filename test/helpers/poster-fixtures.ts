import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";
import type { Platform } from "../../src/config/index.js";
import { approvedParameter, blockedParameter } from "../../src/lambda/connection-paths.js";
import { GITHUB_OIDC_ISSUER, type OidcVerifier } from "../../src/lambda/oidc.js";
import type { ThreadMetadata } from "../../src/lambda/ownership.js";
import { createPoster, type PosterChat, type PosterDeps } from "../../src/lambda/poster.js";
import type { TelegramApi } from "../../src/lambda/telegram.js";
import {
  connectionParameters,
  fakeAttachments,
  fakeParameterStore,
  PARAMETERS,
  REGISTERED_ENTRY,
  registryEntryFor,
} from "./receiver-fixtures.js";

export const GARDEN_REPOSITORY = "octo/garden";
export const OIDC_OWNER = "octo";
export const OIDC_AUDIENCE = "centaur";
export const FUNCTION_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
export const HOUSEHOLD_CHAT_ID = "-100500";
export const SLACK_CHANNEL_ID = "C0123";
export const TOPIC_ID = 77;
export const SLACK_POST_THREAD_ID = "slack:C0123:1700000000.000100";

export const WORKSHOP_CHAT_ID = "-100900";

export const approvedChat = (bot: string, chatId: string, platform: Platform = "telegram") =>
  approvedParameter(bot, platform, "chat", chatId);
const APPROVALS: Record<string, string> = {
  [approvedChat("garden", HOUSEHOLD_CHAT_ID)]: "{}",
  [approvedChat("garden", WORKSHOP_CHAT_ID)]: "{}",
  [approvedChat("notes", SLACK_CHANNEL_ID, "slack")]: "{}",
};

export const blockedChat = (bot: string, chatId: string) =>
  blockedParameter(bot, "telegram", "chat", chatId);

export const ORPHAN_PARAMETERS: Record<string, string> = connectionParameters({
  name: "sprout",
  platform: "telegram",
  token: "sprout-token",
  webhookSecret: "sprout-secret",
});

export const configText = (overrides: Record<string, string | undefined> = {}) =>
  Object.entries({
    bot: "sprout",
    platform: "telegram",
    provider: "anthropic",
    model: "sonnet",
    allowed_tools: "Read",
    ...overrides,
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

export async function createOidcSigner() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const sign = (claims: JWTPayload = {}, key = privateKey, options: { expiresIn?: string } = {}) =>
    new SignJWT({ repository: "octo/sprout", repository_owner: OIDC_OWNER, ...claims })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(claims.iss ?? GITHUB_OIDC_ISSUER)
      .setAudience(claims.aud ?? OIDC_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(key);
  return { keys: async () => publicKey, sign, wrongKey: other.privateKey };
}

export const fakeOidc = (repository = "octo/sprout") => ({
  verify: vi.fn<OidcVerifier["verify"]>(async () => ({ repository })),
});

export const fakeTelegram = () => ({
  getMe: vi.fn<TelegramApi["getMe"]>(async () => ({ username: "garden_bot" })),
  setWebhook: vi.fn<TelegramApi["setWebhook"]>(async () => {}),
  createForumTopic: vi.fn<TelegramApi["createForumTopic"]>(async () => TOPIC_ID),
});

export function fakePosterChat(transcript: unknown[] = []) {
  const state: ThreadMetadata = {};
  const removeReaction = vi.fn(async () => {});
  const rehydrateAttachment = vi.fn((attachment: object) => ({
    ...attachment,
    fetchData: async () => Buffer.from("bytes"),
  }));
  const thread = {
    id: "telegram:-100500:77",
    adapter: { removeReaction, rehydrateAttachment },
    channelId: `telegram:${HOUSEHOLD_CHAT_ID}`,
    isDM: false,
    post: vi.fn(async () => ({ id: "sent-1" })),
    setState: vi.fn(async (next: ThreadMetadata) => {
      Object.assign(state, next);
    }),
    allMessages: (async function* () {
      yield* transcript;
    })(),
  };
  const channelPost = vi.fn(async () => ({ id: "sent-2", threadId: SLACK_POST_THREAD_ID }));
  const listThreads = vi.fn(async () => ({ threads: [], nextCursor: undefined }));
  const fetchChannelMessages = vi.fn(async () => ({ messages: [], nextCursor: undefined }));
  const chat = {
    initialize: vi.fn(async () => {}),
    thread: vi.fn((id: string) => {
      const [platform, chatId] = id.split(":");
      if ((platform === "telegram" || platform === "slack") && id !== thread.id) {
        thread.id = id;
        thread.channelId = `${platform}:${chatId}`;
      }
      return thread;
    }),
    channel: vi.fn(() => ({
      post: channelPost,
      adapter: { name: "fake", listThreads, fetchChannelMessages },
      messages: (async function* () {})(),
    })),
  };
  return {
    chat: chat as unknown as PosterChat,
    chatMock: chat,
    thread,
    removeReaction,
    rehydrateAttachment,
    channelPost,
    listThreads,
    fetchChannelMessages,
    state,
  };
}

export async function posterSetup(
  options: {
    parameters?: Record<string, string>;
    transcript?: unknown[];
    attachments?: Record<string, string[]>;
    registryState?: StateAdapter;
    createState?: (prefix: string) => StateAdapter;
    repository?: string;
    globalMcpPolicy?: string;
  } = {},
) {
  const params = fakeParameterStore({
    ...PARAMETERS,
    "/centaur/chats/slack/notes-channel": SLACK_CHANNEL_ID,
    "/centaur/chats/telegram/workshop": WORKSHOP_CHAT_ID,
    ...APPROVALS,
    ...options.parameters,
  });
  const registryState = options.registryState ?? createMemoryState();
  await registryState.connect();
  await registryState.set("registry:garden", REGISTERED_ENTRY);
  await registryState.set("registry:notes", registryEntryFor("slack"));
  const telegram = fakeTelegram();
  const oidc = fakeOidc(options.repository);
  const posting = fakePosterChat(options.transcript);
  const logger = { warn: vi.fn() };
  const createState = vi.fn(
    options.createState ??
      ((prefix: string) => (prefix === "" ? registryState : createMemoryState())),
  );
  const chatFor = vi.fn<PosterDeps["chatFor"]>(() => posting.chat);
  const attachments = fakeAttachments(options.attachments);
  const poster = await createPoster({
    params,
    createState,
    chatFor,
    attachments,
    telegram,
    oidc,
    globalMcpPolicy: async () => options.globalMcpPolicy,
    functionUrl: FUNCTION_URL,
    logger,
  });
  return {
    poster,
    logger,
    params,
    registryState,
    telegram,
    oidc,
    chatFor,
    createState,
    attachments,
    ...posting,
  };
}

export const SPROUT_SLACK_PARAMETERS = connectionParameters({
  name: "sprout",
  platform: "slack",
  token: "sprout-xoxb",
  webhookSecret: "sprout-signing",
});
