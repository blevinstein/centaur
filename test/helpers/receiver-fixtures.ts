import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { vi } from "vitest";
import type { Access } from "../../src/lambda/access.js";
import type { RepositoryDispatcher } from "../../src/lambda/github.js";
import type { ThreadMetadata } from "../../src/lambda/ownership.js";
import type { ParameterStore } from "../../src/lambda/parameters.js";
import { type Bot, registryKey } from "../../src/lambda/registry.js";

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

export const PARAMETERS: Record<string, string> = {
  "/centaur/bots/garden/platform": "telegram",
  "/centaur/bots/garden/token": GARDEN_BOT.token,
  "/centaur/bots/garden/webhook-secret": GARDEN_BOT.webhookSecret,
  "/centaur/bots/garden/repo": GARDEN_BOT.repo,
  "/centaur/bots/notes/platform": "slack",
  "/centaur/bots/notes/token": SLACK_BOT.token,
  "/centaur/bots/notes/signing-secret": SLACK_BOT.webhookSecret,
  "/centaur/bots/notes/repo": SLACK_BOT.repo,
  "/centaur/bots/unbound/platform": "telegram",
  "/centaur/bots/unbound/token": "t",
  "/centaur/bots/unbound/webhook-secret": "s",
  "/centaur/bots/partial/platform": "slack",
  "/centaur/bots/partial/token": "t",
  "/centaur/bots/partial/repo": "octo/partial",
  "/centaur/users/maintainer/telegram": "1001",
  "/centaur/users/spouse/telegram": "1002",
  "/centaur/chats/household": "-100500",
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
    delete: async (name) => {
      delete values[name];
    },
  };
};

export const fakeDispatcher = () => ({ dispatch: vi.fn<RepositoryDispatcher["dispatch"]>() });

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
  overrides: { isDM?: boolean; state?: ThreadMetadata | null; chatId?: string } = {},
) {
  const { isDM = false, state = null, chatId = GROUP_CHAT_ID } = overrides;
  const addReaction = vi.fn(async () => {});
  const thread = {
    id: `telegram:${chatId}:7`,
    channelId: `telegram:${chatId}`,
    isDM,
    state: Promise.resolve(state),
    post: vi.fn(async () => ({})),
    channel: { fetchMetadata: vi.fn(async () => ({ name: GROUP_CHAT_TITLE })) },
    adapter: { addReaction },
  };
  return { thread: thread as unknown as Thread<ThreadMetadata>, post: thread.post, addReaction };
}

export const fakeMessage = (
  overrides: {
    userId?: string;
    isMention?: boolean;
    isBot?: boolean | "unknown";
    text?: string;
    isMe?: boolean;
    fullName?: string;
  } = {},
) =>
  ({
    id: "telegram:msg-42",
    text: overrides.text ?? MESSAGE_TEXT,
    isMention: overrides.isMention ?? false,
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
