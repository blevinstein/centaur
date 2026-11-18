import { createMemoryState } from "@chat-adapter/state-memory";
import { generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";
import { GITHUB_OIDC_ISSUER, type OidcVerifier } from "../../src/lambda/oidc.js";
import type { ThreadMetadata } from "../../src/lambda/ownership.js";
import { createPoster, type PosterChat } from "../../src/lambda/poster.js";
import type { TelegramApi } from "../../src/lambda/telegram.js";
import { fakeParameterStore, PARAMETERS } from "./receiver-fixtures.js";

export const OIDC_OWNER = "octo";
export const OIDC_AUDIENCE = "centaur";
export const FUNCTION_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
export const HOUSEHOLD_CHAT_ID = "-100500";
export const SLACK_CHANNEL_ID = "C0123";
export const TOPIC_ID = 77;
export const SLACK_POST_THREAD_ID = "slack:C0123:1700000000.000100";

export const REGISTERED_ENTRY = { allow: ["maintainer"], destination: "household" };

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
    destination: "household",
    allow: "[maintainer]",
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
  setWebhook: vi.fn<TelegramApi["setWebhook"]>(async () => {}),
  createForumTopic: vi.fn<TelegramApi["createForumTopic"]>(async () => TOPIC_ID),
});

export function fakePosterChat(transcript: unknown[] = []) {
  const state: ThreadMetadata = {};
  const thread = {
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
  return { chat: chat as unknown as PosterChat, chatMock: chat, thread, channelPost, state };
}

export async function posterSetup(
  options: { parameters?: Record<string, string>; transcript?: unknown[] } = {},
) {
  const params = fakeParameterStore({
    ...PARAMETERS,
    "/centaur/chats/notes-channel": SLACK_CHANNEL_ID,
    ...options.parameters,
  });
  const registryState = createMemoryState();
  await registryState.connect();
  await registryState.set("registry:garden", REGISTERED_ENTRY);
  await registryState.set("registry:notes", {
    allow: ["maintainer"],
    destination: "notes-channel",
  });
  const telegram = fakeTelegram();
  const oidc = fakeOidc();
  const posting = fakePosterChat(options.transcript);
  const stateFor = vi.fn((prefix: string) => (prefix === "" ? registryState : createMemoryState()));
  const chatFor = vi.fn(() => posting.chat);
  const poster = createPoster({
    params,
    stateFor,
    chatFor,
    telegram,
    oidc,
    functionUrl: FUNCTION_URL,
  });
  return { poster, params, registryState, telegram, oidc, chatFor, stateFor, ...posting };
}
