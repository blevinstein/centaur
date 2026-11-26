import { describe, expect, it } from "vitest";
import { SEARCH_TOKEN_TTL_MS } from "../src/lambda/search-token.js";
import {
  MESSAGE_TEXT_MAX,
  SEARCH_CHAT_MAX,
  SEARCH_CONTEXT_MAX,
  SEARCH_QUERY_MAX,
} from "../src/poster-contract.js";
import {
  ENROLLED_USER,
  OTHER_BOT_USER,
  STRANGER,
  TELEGRAM_TARGET,
} from "./helpers/chat-context-fixtures.js";
import { WORKSHOP_CHAT_ID } from "./helpers/poster-fixtures.js";
import {
  ACTION_TOKEN,
  BOT_USER_ID,
  OTHER_CHANNEL_ID,
  SEARCH_REQUEST,
  searchSetup,
  slackContext,
  slackHit,
} from "./helpers/search-chat-fixtures.js";
import { createFakeAws } from "./helpers/workflow-fixtures.js";

describe("search-chat authorization and schema", () => {
  it("refuses a bot bound to a different repository", async () => {
    const { poster, searchSlack, oidc } = await searchSetup();
    oidc.verify.mockResolvedValue({ repository: "octo/other" });

    await expect(poster(SEARCH_REQUEST)).rejects.toThrow(/not bound to octo\/other/);
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("refuses a chat that is not approved", async () => {
    const { poster, searchSlack } = await searchSetup();

    await expect(poster({ ...SEARCH_REQUEST, chatId: "C7777" })).rejects.toThrow(
      /is not approved for bot "notes"/,
    );
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("refuses an approved chat other than the dispatched thread's", async () => {
    const { poster, searchSlack } = await searchSetup({ tokenAgeSeconds: 1 });

    await expect(poster({ ...SEARCH_REQUEST, chatId: WORKSHOP_CHAT_ID })).rejects.toThrow();
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it.each([
    ["an extra field", { actionToken: "x" }],
    ["a missing token", { token: undefined }],
    ["an empty query", { query: "" }],
    ["a query past the maximum", { query: "q".repeat(SEARCH_QUERY_MAX + 1) }],
    ["a limit past the maximum", { limit: SEARCH_CHAT_MAX + 1 }],
    ["a malformed after", { after: "yesterday" }],
  ])("rejects %s", async (_name, override) => {
    const { poster } = await searchSetup();

    await expect(poster({ ...SEARCH_REQUEST, ...override })).rejects.toThrow();
  });
});

describe("search-chat availability", () => {
  it("answers unsupported on Telegram", async () => {
    const { poster, searchSlack } = await searchSetup({ platform: "telegram" });

    await expect(poster({ ...SEARCH_REQUEST, ...TELEGRAM_TARGET })).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported",
    });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("answers no_token when none was captured", async () => {
    const { poster, searchSlack } = await searchSetup({ tokenAgeSeconds: null });

    await expect(poster(SEARCH_REQUEST)).resolves.toEqual({
      status: "unavailable",
      reason: "no_token",
    });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("answers expired with the token's age once it is past the TTL", async () => {
    const { poster, searchSlack } = await searchSetup({
      tokenAgeSeconds: SEARCH_TOKEN_TTL_MS / 1000 + 1,
    });

    await expect(poster(SEARCH_REQUEST)).resolves.toEqual({
      status: "unavailable",
      reason: "expired",
      tokenAgeSeconds: SEARCH_TOKEN_TTL_MS / 1000 + 1,
    });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_action_token", { status: "unavailable", reason: "expired", tokenAgeSeconds: 42 }],
    ["feature_not_enabled", { status: "unavailable", reason: "not_enabled" }],
    ["missing_scope", { status: "unavailable", reason: "not_enabled" }],
    ["rate_limited", { status: "unavailable", reason: "rate_limited", retryAfterSeconds: 30 }],
  ])("maps the Slack error %s", async (error, expected) => {
    const { poster } = await searchSetup({
      tokenAgeSeconds: 42,
      searchResponse: { ok: false, error, retryAfterSeconds: 30 },
    });

    await expect(poster(SEARCH_REQUEST)).resolves.toEqual(expected);
  });

  it("throws any other Slack error carrying only its code", async () => {
    const { poster } = await searchSetup({
      searchResponse: { ok: false, error: "internal_error" },
    });

    await expect(poster(SEARCH_REQUEST)).rejects.toThrow("slack search failed: internal_error");
  });
});

describe("search-chat call and filters", () => {
  it("calls Slack with the bot token, the stored action token and Unix-second bounds", async () => {
    const { poster, searchSlack } = await searchSetup();

    await poster({
      ...SEARCH_REQUEST,
      after: "2026-01-02T03:00:00.000Z",
      before: "2026-01-03T03:00:00.000Z",
      limit: 3,
    });

    expect(searchSlack).toHaveBeenCalledWith({
      botToken: "xoxb-token",
      actionToken: ACTION_TOKEN,
      query: SEARCH_REQUEST.query,
      channelId: "C0123",
      limit: 3,
      after: Date.UTC(2026, 0, 2, 3) / 1000,
      before: Date.UTC(2026, 0, 3, 3) / 1000,
    });
  });

  it("returns only the dispatched channel's messages from enrolled senders and the bot", async () => {
    const { poster } = await searchSetup({
      searchResponse: {
        ok: true,
        messages: [
          slackHit({ message_ts: "1" }),
          slackHit({ message_ts: "2", channel_id: OTHER_CHANNEL_ID }),
          slackHit({ message_ts: "3", author_user_id: STRANGER }),
          slackHit({ message_ts: "4", author_user_id: OTHER_BOT_USER, is_author_bot: true }),
          slackHit({ message_ts: "5", author_user_id: BOT_USER_ID, is_author_bot: true }),
          { ...slackHit({ message_ts: "6" }), author_user_id: undefined },
        ],
      },
    });

    const result = await poster(SEARCH_REQUEST);

    expect(result).toMatchObject({ status: "ok" });
    expect((result as { results: { ts: string; fromBot: boolean }[] }).results).toEqual([
      expect.objectContaining({ ts: "1", fromBot: false }),
      expect.objectContaining({ ts: "5", fromBot: true }),
    ]);
  });

  it("keeps another bot's message only with includeBots", async () => {
    const { poster } = await searchSetup({
      searchResponse: {
        ok: true,
        messages: [slackHit({ author_user_id: OTHER_BOT_USER, is_author_bot: true })],
      },
    });

    const result = await poster({ ...SEARCH_REQUEST, includeBots: true });

    expect(result).toMatchObject({ status: "ok", results: [{ userId: OTHER_BOT_USER }] });
  });

  it("clips text and keeps only enrolled, nearest context messages", async () => {
    const { poster } = await searchSetup({
      searchResponse: {
        ok: true,
        messages: [
          slackHit({
            content: "x".repeat(MESSAGE_TEXT_MAX + 50),
            context_messages: {
              before: [
                slackContext(ENROLLED_USER, "far"),
                slackContext(STRANGER, "hidden"),
                slackContext(ENROLLED_USER, "mid"),
                slackContext(BOT_USER_ID, "near"),
              ],
              after: [
                slackContext(OTHER_BOT_USER, "bot"),
                slackContext(ENROLLED_USER, "a1"),
                slackContext(ENROLLED_USER, "a2"),
                slackContext(ENROLLED_USER, "a3"),
              ],
            },
          }),
        ],
      },
    });

    const result = (await poster(SEARCH_REQUEST)) as {
      results: {
        text: string;
        context: { before: { text: string }[]; after: { text: string }[] };
      }[];
    };

    expect(result.results[0]?.text).toHaveLength(MESSAGE_TEXT_MAX);
    expect(result.results[0]?.context.before.map(({ text }) => text)).toEqual(["mid", "near"]);
    expect(result.results[0]?.context.after.map(({ text }) => text)).toEqual(["a1", "a2"]);
    expect(SEARCH_CONTEXT_MAX).toBe(2);
  });

  it("returns no more than the limit", async () => {
    const { poster } = await searchSetup({
      searchResponse: {
        ok: true,
        messages: [slackHit({ message_ts: "1" }), slackHit({ message_ts: "2" })],
      },
    });

    const result = (await poster({ ...SEARCH_REQUEST, limit: 1 })) as { results: unknown[] };

    expect(result.results).toHaveLength(1);
  });

  it("logs neither the query, the text nor the token, and never returns the token", async () => {
    const { poster, logger } = await searchSetup({
      searchResponse: { ok: true, messages: [slackHit()] },
    });

    const result = await poster(SEARCH_REQUEST);

    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).not.toContain(SEARCH_REQUEST.query);
    expect(logged).not.toContain("blight on the tomatoes");
    expect(logged).not.toContain(ACTION_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACTION_TOKEN);
  });
});

describe("the poster client's searchChat", () => {
  it("sends search-chat and parses the result", async () => {
    const aws = createFakeAws(() => ({ status: "unavailable", reason: "no_token" }));
    const { operation: _operation, ...request } = SEARCH_REQUEST;

    await expect(aws.poster.searchChat(request)).resolves.toEqual({
      status: "unavailable",
      reason: "no_token",
    });
    expect(aws.requests).toEqual([SEARCH_REQUEST]);
  });

  it("rejects a result of an unknown shape", async () => {
    const aws = createFakeAws(() => ({ status: "maybe" }));
    const { operation: _operation, ...request } = SEARCH_REQUEST;

    await expect(aws.poster.searchChat(request)).rejects.toThrow();
  });
});
