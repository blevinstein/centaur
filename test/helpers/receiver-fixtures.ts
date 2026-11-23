import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { vi } from "vitest";
import type { Platform, PlatformSettings } from "../../src/config/index.js";
import type { Access } from "../../src/lambda/access.js";
import type { AttachmentStore } from "../../src/lambda/attachments.js";
import {
  repoParameter,
  tokenParameter,
  webhookSecretParameter,
} from "../../src/lambda/connection-paths.js";
import type { RepositoryDispatcher } from "../../src/lambda/github.js";
import type { ThreadMetadata } from "../../src/lambda/ownership.js";
import type { ParameterStore } from "../../src/lambda/parameters.js";
import { type Bot, type BotSecrets, registryKey } from "../../src/lambda/registry.js";

export const GARDEN_BOT: Bot = {
  name: "garden",
  platform: "telegram",
  repo: "octo/garden",
  token: "tg-token",
  webhookSecret: "tg-secret",
};

export const SLACK_BOT: Bot = {
  name: "notes",
  platform: "slack",
  repo: "octo/notes",
  token: "xoxb-token",
  webhookSecret: "signing-secret",
};

export const connectionParameters = (
  { name, platform, token, webhookSecret }: BotSecrets,
  repo?: string,
): Record<string, string> => ({
  [tokenParameter(name, platform)]: token,
  [webhookSecretParameter(name, platform)]: webhookSecret,
  ...(repo ? { [repoParameter(name)]: repo } : {}),
});

const UNBOUND_BOT: BotSecrets = { ...GARDEN_BOT, name: "unbound", token: "t", webhookSecret: "s" };

export const GARDEN_SLACK_BOT: Bot = {
  ...SLACK_BOT,
  name: GARDEN_BOT.name,
  repo: GARDEN_BOT.repo,
  token: "xoxb-garden",
  webhookSecret: "garden-signing-secret",
};

export const PARAMETERS: Record<string, string> = {
  ...connectionParameters(GARDEN_BOT, GARDEN_BOT.repo),
  ...connectionParameters(SLACK_BOT, SLACK_BOT.repo),
  ...connectionParameters(UNBOUND_BOT),
  [tokenParameter("partial", "slack")]: "t",
  [repoParameter("partial")]: "octo/partial",
  "/centaur/chats/household": "-100500",
};

export const GARDEN_SLACK_PARAMETERS = connectionParameters(GARDEN_SLACK_BOT);

export const FLAT_PARAMETERS = {
  "/centaur/bots/flat/platform": "telegram",
  "/centaur/bots/flat/token": "t",
  "/centaur/bots/flat/webhook-secret": "s",
  "/centaur/bots/flat/repo": "octo/flat",
};

export const GROUP_CHAT_ID = "-100500";
export const ALLOWED_USER_ID = "1001";
export const GROUP_CHAT_TITLE = "Garden Club";
export const STRANGER_USER_ID = "9999";
export const MESSAGE_TEXT = "the tomatoes have yellow leaves";

export const fakeParameterStore = (
  initial = PARAMETERS,
): ParameterStore & { values: Record<string, string> } => {
  const values = { ...initial };
  return {
    values,
    get: async (name) => values[name],
    getByPath: async (path) =>
      Object.fromEntries(Object.entries(values).filter(([name]) => name.startsWith(`${path}/`))),
    put: async (name, value) => {
      values[name] = value;
    },
    putIfAbsent: async (name, value) => {
      if (name in values) return false;
      values[name] = value;
      return true;
    },
    delete: async (name) => {
      delete values[name];
    },
  };
};

export const twoConnections = () =>
  fakeParameterStore({ ...PARAMETERS, ...GARDEN_SLACK_PARAMETERS });

export const fakeDispatcher = () => ({ dispatch: vi.fn<RepositoryDispatcher["dispatch"]>() });

export const fakeAttachments = (stored: Record<string, string[]> = {}) => ({
  save: vi.fn<AttachmentStore["save"]>(async () => []),
  forThread: vi.fn<AttachmentStore["forThread"]>(
    async () => (messageId) => stored[messageId] ?? [],
  ),
});

export function fakeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return logger;
}

export const accessFor = (overrides: Partial<Access> = {}): (() => Promise<Access>) => {
  const access = {
    userIds: new Set([ALLOWED_USER_ID]),
    chatIds: new Set([GROUP_CHAT_ID]),
    blockedUserIds: new Set<string>(),
    blockedChatIds: new Set<string>(),
    ...overrides,
  };
  return vi.fn(async () => access);
};

export function fakeThread(
  overrides: {
    isDM?: boolean;
    state?: ThreadMetadata | null;
    chatId?: string;
    title?: string | null;
  } = {},
) {
  const {
    isDM = false,
    state = null,
    chatId = GROUP_CHAT_ID,
    title = GROUP_CHAT_TITLE,
  } = overrides;
  const addReaction = vi.fn(async () => {});
  const setState = vi.fn(async () => {});
  const thread = {
    id: `telegram:${chatId}:7`,
    channelId: `telegram:${chatId}`,
    isDM,
    state: Promise.resolve(state),
    setState,
    post: vi.fn(async () => ({})),
    adapter: {
      addReaction,
      fetchThread: vi.fn(async () => ({ channelName: title ?? undefined })),
    },
  };
  return {
    thread: thread as unknown as Thread<ThreadMetadata>,
    post: thread.post,
    setState,
    addReaction,
    fetchThread: thread.adapter.fetchThread,
  };
}

export const fakeMessage = (
  overrides: {
    userId?: string;
    isMention?: boolean;
    isBot?: boolean | "unknown";
    text?: string;
    isMe?: boolean;
    fullName?: string;
    attachments?: unknown[];
  } = {},
) =>
  ({
    id: "telegram:msg-42",
    text: overrides.text ?? MESSAGE_TEXT,
    isMention: overrides.isMention ?? false,
    attachments: overrides.attachments ?? [],
    author: {
      userId: overrides.userId ?? ALLOWED_USER_ID,
      fullName: overrides.fullName ?? "Pat Example",
      isBot: overrides.isBot ?? false,
      isMe: overrides.isMe ?? false,
    },
  }) as unknown as Message;

export async function registryStateWith(entries: Record<string, unknown>) {
  const state = createMemoryState();
  await state.connect();
  for (const [bot, entry] of Object.entries(entries)) {
    await state.set(registryKey(bot), entry);
  }
  return state;
}

export const registryEntryFor = (
  ...platforms: Platform[]
): { platforms: Partial<Record<Platform, PlatformSettings>> } => ({
  platforms: Object.fromEntries(platforms.map((platform) => [platform, { respond_to: "mention" }])),
});

export const REGISTERED_ENTRY = registryEntryFor("telegram");
