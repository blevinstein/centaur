import { createMemoryState } from "@chat-adapter/state-memory";
import { generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";
import { GITHUB_OIDC_ISSUER, type OidcVerifier } from "../../src/lambda/oidc.js";
import type { ThreadMetadata } from "../../src/lambda/ownership.js";
import { createPoster, type PosterChat } from "../../src/lambda/poster.js";
import type { TelegramApi } from "../../src/lambda/telegram.js";
import { fakeAttachments, fakeParameterStore, PARAMETERS } from "./receiver-fixtures.js";

export const OIDC_OWNER = "octo";
export const OIDC_AUDIENCE = "centaur";
export const FUNCTION_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
export const HOUSEHOLD_CHAT_ID = "-100500";
export const SLACK_CHANNEL_ID = "C0123";
export const TOPIC_ID = 77;
export const SLACK_POST_THREAD_ID = "slack:C0123:1700000000.000100";

export const WORKSHOP_CHAT_ID = "-100900";
export const REGISTERED_ENTRY = { respond_to: "mention" };

export const approvedChat = (bot: string, chatId: string) =>
  `/centaur/bots/${bot}/approved-chats/${chatId}`;
const APPROVALS: Record<string, string> = {
  [approvedChat("garden", HOUSEHOLD_CHAT_ID)]: "{}",
  [approvedChat("garden", WORKSHOP_CHAT_ID)]: "{}",
  [approvedChat("notes", SLACK_CHANNEL_ID)]: "{}",
};

export const blockedChat = (bot: string, chatId: string) =>
  `/centaur/bots/${bot}/blocked/chat/${chatId}`;

export const ORPHAN_PARAMETERS: Record<string, string> = {
  "/centaur/bots/sprout/platform": "telegram",
  "/centaur/bots/sprout/token": "sprout-token",
  "/centaur/bots/sprout/webhook-secret": "sprout-secret",
  "/centaur/bots/ghost/platform": "telegram",
};

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
  const chat = {
    initialize: vi.fn(async () => {}),
    thread: vi.fn(() => thread),
    channel: vi.fn(() => ({ post: channelPost })),
  };
  return {
    chat: chat as unknown as PosterChat,
    chatMock: chat,
    thread,
    removeReaction,
    rehydrateAttachment,
    channelPost,
    state,
  };
}

export async function posterSetup(
  options: {
    parameters?: Record<string, string>;
    transcript?: unknown[];
    attachments?: Record<string, string[]>;
  } = {},
) {
  const params = fakeParameterStore({
    ...PARAMETERS,
    "/centaur/chats/notes-channel": SLACK_CHANNEL_ID,
    "/centaur/chats/workshop": WORKSHOP_CHAT_ID,
    ...APPROVALS,
    ...options.parameters,
  });
  const registryState = createMemoryState();
  await registryState.connect();
  await registryState.set("registry:garden", REGISTERED_ENTRY);
  await registryState.set("registry:notes", REGISTERED_ENTRY);
  const telegram = fakeTelegram();
  const oidc = fakeOidc();
  const posting = fakePosterChat(options.transcript);
  const logger = { warn: vi.fn() };
  const stateFor = vi.fn((prefix: string) => (prefix === "" ? registryState : createMemoryState()));
  const chatFor = vi.fn(() => posting.chat);
  const attachments = fakeAttachments(options.attachments);
  const poster = createPoster({
    params,
    stateFor,
    chatFor,
    attachments,
    telegram,
    oidc,
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
    stateFor,
    attachments,
    ...posting,
  };
}
