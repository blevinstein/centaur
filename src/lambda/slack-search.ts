import { z } from "zod";

const SEARCH_URL = "https://slack.com/api/assistant.search.context";

const contextMessageSchema = z.object({
  user_id: z.string().optional(),
  ts: z.string().optional(),
  text: z.string().optional(),
});

const messageSchema = z.object({
  author_user_id: z.string().optional(),
  author_name: z.string().optional(),
  channel_id: z.string(),
  message_ts: z.string(),
  content: z.string().optional(),
  is_author_bot: z.boolean().optional(),
  permalink: z.string().optional(),
  context_messages: z
    .object({
      before: z.array(contextMessageSchema).optional(),
      after: z.array(contextMessageSchema).optional(),
    })
    .optional(),
});

const bodySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  results: z.object({ messages: z.array(messageSchema).optional() }).optional(),
});

export type SlackSearchMessage = z.infer<typeof messageSchema>;

export interface SlackSearchParams {
  botToken: string;
  actionToken: string;
  query: string;
  channelId: string;
  limit: number;
  /** Unix seconds. */
  after?: number | undefined;
  before?: number | undefined;
}

export type SlackSearchResponse =
  | { ok: true; messages: SlackSearchMessage[] }
  | { ok: false; error: string; retryAfterSeconds?: number };

export type SlackSearchApi = (params: SlackSearchParams) => Promise<SlackSearchResponse>;

const IN_CLAUSE = /-?\bin:[^\s)]*/gi;

/** Slack searches the whole workspace; only `in:<#ID>` restricts it, so the agent's own `in:` clauses are dropped. */
export const scopedQuery = (query: string, channelId: string) =>
  `in:<#${channelId}> ${query.replaceAll(IN_CLAUSE, " ").replaceAll(/\s+/g, " ").trim()}`.trim();

/** One `assistant.search.context` call over public channels; Slack failures come back as `ok: false`, never thrown. */
export function createSlackSearchApi(fetchImpl: typeof fetch = fetch): SlackSearchApi {
  return async ({ botToken, actionToken, query, channelId, limit, after, before }) => {
    const response = await fetchImpl(SEARCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        query: scopedQuery(query, channelId),
        action_token: actionToken,
        context_channel_id: channelId,
        channel_types: ["public_channel"],
        content_types: ["messages"],
        include_context_messages: true,
        limit,
        ...(after === undefined ? {} : { after }),
        ...(before === undefined ? {} : { before }),
      }),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ok: false,
        error: "ratelimited",
        ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
      };
    }
    if (!response.ok) throw new Error(`slack search returned HTTP ${response.status}`);
    const body = bodySchema.parse(await response.json());
    if (!body.ok) return { ok: false, error: body.error ?? "unknown_error" };
    return { ok: true, messages: body.results?.messages ?? [] };
  };
}
