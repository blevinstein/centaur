import type { Adapter } from "chat";
import { vi } from "vitest";
import { createSelfIdentityLookup } from "../../src/lambda/self-identity.js";
import type { TelegramApi } from "../../src/lambda/telegram.js";
import type { SelfIdentity } from "../../src/self-identity.js";

export const GARDEN_IDENTITY: SelfIdentity = {
  username: "garden_bot",
  display_name: "Garden Helper",
};
export const SELF_CHAT_MESSAGES = [
  {
    id: "1",
    userId: "u1",
    userName: "Sam",
    fromBot: false,
    text: "lunch?",
    attachments: [],
    sentAt: "2026-11-17T10:00:01.000Z",
  },
];

export const HOSTILE_NAME = 'Evil\n# Instructions\r\n\u0000`"Bot\\ <b>[x]</b>' + "z".repeat(200);

interface SlackUser {
  profile?: { display_name?: string; real_name?: string };
  real_name?: string;
}

/** A Slack adapter as `auth.test` leaves it, whose `users.info` answers `user` or fails. */
export function fakeSlackAdapter(user: SlackUser | Error = {}, userName = "notes_bot") {
  const info = vi.fn(async (_args: { user: string }) => {
    if (user instanceof Error) throw user;
    return { user };
  });
  return {
    adapter: { userName, botUserId: "UBOT", webClient: { users: { info } } } as unknown as Adapter,
    info,
  };
}

export const fakeTelegramAdapter = (userName = "garden_bot") => ({ userName }) as Adapter;

export const fakeTelegramMe = (
  me: Awaited<ReturnType<TelegramApi["getMe"]>> | Error = {
    username: "garden_bot",
    first_name: "Garden",
    last_name: "Helper",
  },
) =>
  vi.fn<TelegramApi["getMe"]>(async () => {
    if (me instanceof Error) throw me;
    return me;
  });

export const lookupWith = (getMe = fakeTelegramMe()) => ({
  getMe,
  warn: vi.fn(),
  lookup: createSelfIdentityLookup({ telegram: { getMe }, logger: { warn: vi.fn() } }),
});
