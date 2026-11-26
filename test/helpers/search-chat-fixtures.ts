import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { createSearchTokenStore } from "../../src/lambda/search-token.js";
import type { SlackSearchApi, SlackSearchMessage } from "../../src/lambda/slack-search.js";
import {
  contextSetup,
  ENROLLED_USER,
  SLACK_TARGET,
  SLACK_THREAD,
} from "./chat-context-fixtures.js";
import { SLACK_CHANNEL_ID } from "./poster-fixtures.js";

export const SEARCH_REQUEST = {
  operation: "search-chat",
  ...SLACK_TARGET,
  query: "tomato blight",
} as const;
export const ACTION_TOKEN = "action-token-secret";
export const BOT_USER_ID = "UBOT";
export const OTHER_CHANNEL_ID = "C9999";

export const slackHit = (overrides: Partial<SlackSearchMessage> = {}): SlackSearchMessage => ({
  author_user_id: ENROLLED_USER,
  author_name: "pat",
  channel_id: SLACK_CHANNEL_ID,
  message_ts: "1700000000.000200",
  content: "blight on the tomatoes",
  is_author_bot: false,
  permalink: "https://example.slack.com/archives/C0123/p1700000000000200",
  ...overrides,
});

export const slackContext = (userId: string, text: string, ts = "1700000000.000100") => ({
  user_id: userId,
  ts,
  text,
});

export async function searchSetup(
  options: {
    searchResponse?: Awaited<ReturnType<SlackSearchApi>>;
    /** Seconds before now that the token was captured; `null` stores none. */
    tokenAgeSeconds?: number | null;
    platform?: "slack" | "telegram";
  } = {},
) {
  const botState = createMemoryState();
  await botState.connect();
  const searchSlack = vi.fn<SlackSearchApi>(
    async () => options.searchResponse ?? { ok: true, messages: [] },
  );
  const setup = await contextSetup({
    platform: options.platform ?? "slack",
    botState,
    searchSlack,
  });
  Object.assign(setup.thread.adapter, { botUserId: BOT_USER_ID });
  if (options.tokenAgeSeconds !== null) {
    const capturedAt = new Date(Date.now() - (options.tokenAgeSeconds ?? 5) * 1000);
    await createSearchTokenStore(botState, "notes", () => capturedAt).capture(SLACK_THREAD, {
      id: "m1",
      raw: { action_token: ACTION_TOKEN },
      author: { userId: ENROLLED_USER },
    } as never);
  }
  return { ...setup, searchSlack, botState };
}
