# Searching chat history (proposal)

> **Status: proposal.** Nothing here is built. It extends [chat-context.md](chat-context.md), which
> keeps search out of scope, and feeds the bounded transcript work (TODO section 15). Terms (poster,
> receiver, turn, state table) are defined in [plan.md](plan.md), [poster.md](poster.md) and
> [workflows.md](workflows.md).

## Summary

- **Does the Chat SDK search chat history? No.** The `chat` package (4.45.0) and the Slack,
  Telegram and DynamoDB state adapters expose only reads by position: `fetchMessages`,
  `fetchChannelMessages`, `listThreads`, `fetchThread` (newest or oldest first, cursor paging).
  There is no `search`, text `query` or `find` anywhere in their types.
- **Do the platforms?** Slack does, but not for this bot's token as installed. `search.messages`
  needs a user token (`search:read`). `assistant.search.context` accepts a bot token only with a
  short-lived `action_token` taken from a message event, and the manifest has none of its scopes.
  Telegram's Bot API has no history or search method at all.
- **So Centaur must provide its own search**, if it wants any. What it stores today cannot support
  more than a bounded filter: the receiver keeps only the newest 100 messages per chat on Telegram
  and nothing on Slack.
- **Recommendation:** phase 1, add a bounded `query` filter to the existing tools, applied in the
  poster over the window it already reads (Option B); no new infrastructure. Defer an index and
  embeddings until real use shows the agent needs more than the window holds. Use Slack-native
  search only as an opt-in later phase.

## What the SDK provides

Checked in `node_modules` (all 4.45.0 except the state adapter, 0.4.0).

| Surface | Signature (file) | Notes |
|---|---|---|
| `Adapter.fetchMessages` | `(threadId, options?: FetchOptions) => Promise<FetchResult>` (`chat/dist/types-C-pbZWL1.d.ts`) | `FetchOptions` is `cursor`, `direction` (`forward`/`backward`), `limit`. No text or sender filter. |
| `Adapter.fetchChannelMessages?` | `(channelId, options?)` | Top-level channel messages. Optional method. |
| `Adapter.listThreads?` | `(channelId, options?: { cursor, limit })` | Thread parents with `replyCount`, `lastReplyAt`. |
| `Adapter.fetchThread`, `fetchChannelInfo?` | | Metadata only. |
| `chat.history.thread / channel / user` | `list`, `collect`, `listMessages`, `listThreads`, `listThreadsWithMessages` | Wrappers over the above plus the SDK-side cache. |
| `TranscriptsApi` (`history.user`) | `append`, `count`, `delete`, `list({ userKey, threadId?, platforms?, roles?, limit })` | Per-user store keyed by a cross-platform identity. Filters are structural, not text. Not enabled here (needs an `IdentityResolver`); capped by `maxPerUser` (default 200). |
| Tool factory (`chat/dist/toolset-VI-9LTRZ.d.ts`) | `ChatToolName` lists `fetchMessages`, `fetchChannelMessages`, `fetchThread`, `listThreads`, `getThreadParticipants`, `getChannelInfo`, `getUser`, post/edit/react tools | The SDK's own agent tools have no search tool either. |
| Slack adapter (`@chat-adapter/slack/dist/index.js`) | Calls `conversations.history`, `conversations.replies`, `conversations.info`, `conversations.list`, `conversations.open`, `assistant.threads.*` | No `search.*` or `assistant.search.*` call. `force_search` appears only as a field of the `assistant_thread_*` event payload type, not an API. No `action_token` handling. |
| Telegram adapter | `fetchMessages`, `fetchChannelMessages`, `fetchThread`, `fetchChannelInfo`; `persistThreadHistory` defaults to `true` | Served from the SDK-side cache, since the Bot API has no history call. |
| DynamoDB state adapter | `get`, `set`, `appendToList`, `getList`, `enqueue`, locks; `TABLE_DEFINITION` is `pk`/`sk` with TTL on `ttl` | Key-value and list operations only. `getList` reads every live row of one list key. No secondary index. |

It does not provide: text search, sender or date filters on fetches, an index, embeddings, or any
history for Slack beyond the live API.

## What the platforms provide

Fetched from the official pages into `/tmp/fetch-out/` with `vet curl`.

**Slack**

| API | Token and scope | Verdict for Centaur |
|---|---|---|
| `search.messages` (<https://api.slack.com/methods/search.messages>) | "User token: `search:read`". Tier 2 (20+/min). Page says it is a legacy method and recommends `assistant.search.context`. | A bot token cannot call it. Needs each user to authorize a user token. Results follow that user's visibility. |
| `assistant.search.context` ("Real-time Search API", <https://api.slack.com/methods/assistant.search.context>, <https://docs.slack.dev/apis/web-api/real-time-search-api>) | Bot token scopes `search:read.public`, `search:read.files`, `search:read.users`; user token adds `search:read.im`, `.mpim`, `.private`. "All API calls made using a bot token require an `action_token`", obtained from a `message` or `app_mention` event payload. Keyword plus semantic retrieval; `disable_semantic_search`; filters `before`/`after`; 20 results per page; about 10 requests per minute for most teams. Page describes it for "an app using AI features". | The one workable Slack-native path: public channels only with a bot token, and only while a turn holds a fresh `action_token`. The receiver sees it but the runner does not, so it would be passed through dispatch and the poster. Token lifetime is not documented on the page (unverified). Needs new manifest scopes and, per the page, workspace support for AI features (unverified for a personal workspace). |
| `conversations.history`, `.replies` (<https://api.slack.com/methods/conversations.history>) | Bot token with `channels:history` etc. Tier 3 (50+/min). | Reads by position only. Already used. |

Rate limits: Slack reduced `conversations.history` and `.replies` to 1 request per minute and 15
messages per request for commercially distributed apps outside the Marketplace
(<https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps>). The
page names "commercially distributed" apps, which a single-workspace app per repo is not, but
whether an installed single-workspace app is exempt was not verified on a real install (already a
**[HUMAN ACTION]** in chat-context.md step 3).

**Telegram.** The Bot API reference (<https://core.telegram.org/bots/api>, Bot API 10.5) has no
history, message search or `getChatHistory`-style method. The only "search" in the page concerns
inline mode. A bot learns messages only from updates, which Telegram holds at most 24 hours until
received. Confirmed by searching the raw page text; absence of a method is shown by absence from the
reference.

## What Centaur stores today

- **State table** (`infra/centaur.yml`, `StateTable`): `pk`/`sk`, TTL on `ttl`, pay-per-request,
  `DeletionPolicy: Retain`.
- **Message history** is written only by `Chat` for adapters with `persistThreadHistory` (Telegram;
  Slack does not set it). On each incoming message it calls `appendToList("msg-history:<threadId>")`
  and, when different, `msg-history:<channelId>` (`chat/dist/index.js`, `ThreadHistoryCache`). It
  stores `message.toJSON()` with `raw` removed, `maxLength` 100 and a 7-day TTL by default.
  `src/lambda/chat.ts` passes no `history` config, so those defaults apply.
- **Consequence for the 2000 cap.** `STORED_HISTORY_SCAN_MAX = 2000` in `src/lambda/chat-context.ts`
  bounds the scan, but the channel list never holds more than 100 rows, so on Telegram the reader
  sees at most the newest 100 messages of the chat, and `list-threads` groups only those. The TTL is
  on the list header and refreshes on every append, so a list expires after 7 days of silence rather
  than aging out per message; rows are trimmed only by count. Documented from `docs/research.md` and
  confirmed in `@blevinstein/chat-state-dynamodb/dist/index.mjs` (`appendToList`, `entries`, `trim`).
- **Slack** keeps nothing; every read is a live `conversations.history` call, so history is
  unbounded but rate limited and not searchable.
- **Sender filtering** (`visibleTo` in `chat-context.ts`): enrolled users and the bot's own messages;
  other bots only with `includeBots`. The stored Telegram history includes unenrolled senders
  (stored before access checks), so anything built on the stored rows, including an index, must apply
  the same filter at read time, or never index those rows.
- **Realistic size.** Not measured; estimates only. A text message is hundreds of bytes, so even a
  busy group at 200 messages a day is about 70,000 messages (tens of MB) a year. That is small for
  any index and large for a per-request scan of a single DynamoDB list. Telegram's current 100-message
  window is far below it.
- **DynamoDB and keyword search.** A `Query` on one `pk` reads rows in order and bills the bytes it
  reads (about one read unit per 4 KB strongly consistent), whether or not a `FilterExpression`
  matches, and each page returns at most 1 MB. A 100-row window is trivial (well under a cent per
  thousand reads at list on-demand prices; prices not re-verified). Raising the window to tens of
  thousands of rows means reading and filtering everything per query: slow (many sequential pages),
  and the SDK adapter's `getList` and its trim after every append already read the whole list.
  DynamoDB has no full-text or substring index, so a larger corpus needs another store.

## Options

Each plugs in behind the existing tools. The MCP server (`src/mcp/chat-server.ts`) gains a
`search_chat` tool (or a `query` argument on `read_channel`), a new `ChatPosterClient` method, and a
poster operation `search-chat` with the same OIDC, repo-binding, chat-scope and sender-filter rules
as `read-channel`. Results use the existing `ChannelMessage` shape, thread handles and fenced
rendering. Failures log bot, chat and counts, never the query or content.

| | Option | How | Cost and latency | Privacy | Ops burden | Failure modes |
|---|---|---|---|---|---|---|
| a | No search; agent filters | Widen existing `read_channel`/`read_thread` filters (`before`, `after`, `sender`) and let the agent page | Tokens: every page the agent reads goes into context. Latency: one poster call per page. | Nothing new | None | Agent gives up early or burns context paging; on Telegram it can never go past 100 messages |
| b | Poster-side substring filter | `query` (case-insensitive substring, per message, whole-word optional) applied after the sender filter over the window the reader already scans (Telegram: stored list; Slack: up to N `conversations.history` pages, default 3, max 10) | Same reads as today; filter is free. Slack pages are 1 call each (rate limited). | Query and text stay in the poster and the MCP server; nothing in logs | None | Misses anything outside the window, says nothing about it unless the result states the scanned range; no stemming or ranking; Slack rate limits |
| c | Keyword index | (c1) Per-request in-memory index over a bounded window: build SQLite FTS5 (or MiniSearch) in the poster from the scanned messages, query, discard. (c2) Managed: OpenSearch Serverless, or a separate store fed by the receiver. | c1: no new storage, adds a native or WASM dependency to the Lambda bundle and CPU per request; useless when the window is the bottleneck, since it indexes what b already scans. c2: OpenSearch Serverless has a minimum standing cost (several hundred dollars a month at list; not verified) and VPC or IAM setup. | c2 puts message text in a second store that needs its own retention and deletion | c1 low. c2 high, out of proportion for a self-hosted single-owner stack | c1: only as good as the window. c2: index lag, deletion drift (edited or deleted messages must be reindexed), extra credentials |
| d | Semantic search (embeddings) | Embed each message at receive time (or lazily on first search), store vectors, rank by cosine similarity; optionally rerank | Anthropic has no embeddings model ("Anthropic does not offer its own embedding model", <https://platform.claude.com/docs/en/build-with-claude/embeddings>), which names Voyage AI (`voyage-4-lite` for cost, `voyage-4` balanced, 1024 dims by default, 256 to 2048 selectable, `input_type` of `document` or `query`, unit-normalized so dot product equals cosine) via MongoDB Atlas model API keys (`https://ai.mongodb.com/v1/embeddings`) or AWS Marketplace. Pricing: see the Voyage page (not fetched). One embedding call per message at receive time puts a third-party call on the receiver's critical path unless done asynchronously. | Every message text leaves the AWS account to the embedding vendor, including from unenrolled senders unless filtered before embedding; a new data processor to disclose. Vectors are reversible enough to treat as message content. | New secret, new SDK, a vector store (DynamoDB rows of 4 KB per 1024-float32 vector, or int8 and 256 dims for 256 B; brute-force cosine over a bounded set in the poster is fine up to tens of thousands of vectors, beyond that a vector index such as OpenSearch is needed), a backfill job, and deletion that follows message deletion and TTL | Vendor outage or rate limit stalls indexing; model change invalidates all vectors; embeddings miss exact tokens (IDs, error strings), which keyword search handles; Telegram history before the feature ships is not backfillable beyond the 100 stored |
| e | Slack-native search | Poster calls `assistant.search.context` with the bot token and a forwarded `action_token` (public channels), or `search.messages` with a per-user token stored in SSM | No storage. Rate limited (about 10 per minute); results include permalinks and context messages. | Slack searches its own data; results follow the token's visibility, so a user token can surface messages from channels the bot is not in, which breaks the one-chat scope | Manifest scopes, a `action_token` through dispatch, or an OAuth user-token flow; Slack-only | Token expiry mid-turn, workspace without the feature, cross-chat leakage, no Telegram equivalent so behavior differs by platform |

Ranking and quality, briefly: substring matching returns matches newest first, which is enough for
"find where we discussed X" in a short window. Keyword indexes add stemming and BM25. Embeddings help
paraphrase queries and cost exact-token recall; the usual pairing is keyword plus vectors with a
reranker, which is more than this project needs now.

## Recommendation

Phase the work behind evidence of need.

1. **Now (cheap, no infrastructure): Option b plus widened filters from a.** Add optional `query`,
   `after` and `sender` arguments to `read-channel` and a `query` to `list-threads`, filtering inside
   the poster after the enrolled-sender filter, over the existing bounded scan. Every result states
   the scanned range (oldest message examined and whether the window was exhausted), so "no matches"
   is never mistaken for "does not exist". Slack scans a capped number of history pages; Telegram
   scans the stored list.
2. **Fix the real limit first if it matters: raise Telegram's stored window.** The 100-message
   channel list is the binding constraint on Telegram, not search. Set `history.thread` (`maxMessages`,
   `ttlMs`) explicitly for the Telegram adapter's chat, with the cost noted above (the adapter reads
   the whole list on every append, which should be measured before going to thousands).
3. **Later, only if phase 1 proves insufficient: Slack-native opt-in (e)**, public channels, since it
   needs no storage and no new data processor. Then c1 if a larger Telegram window makes
   per-request scans slow. Defer embeddings (d) and OpenSearch (c2): they add a data processor or a
   standing cost for a corpus measured in tens of thousands of messages.

What would change the recommendation: a chat whose history regularly exceeds a scannable window
(more than a few thousand messages the agent must search); measured agent behavior showing it pages
many times to find things; a hosted multi-tenant mode (TODO "Explore a hosted option"), where a
shared index, per-tenant isolation and data-processor disclosure become central and a managed
store with per-tenant partitions becomes more reasonable than per-request scans; Slack granting
unrestricted search to bot tokens; or Anthropic shipping embeddings.

## Bounded transcript interaction

The omission note in [workflows.md](workflows.md#transcript-budget-planned) points the agent at
`read_thread` with `before`. With phase 1 the agent can instead call the search tool with a keyword
from the topic and jump to the relevant older messages, without paging through everything the budget
dropped. The search tool must not widen `scope`: it reads the dispatched thread's own chat only.

## Decisions

Recommendations in bold; each needs the maintainer's approval before building.

1. **No separate search infrastructure for now.** Filter in the poster (phase 1); revisit with data.
2. **Substring, case-insensitive, per message**, applied after the sender filter, with the scanned
   range reported in every result.
3. **Bounds:** at most 10 Slack history pages and the stored list on Telegram per search, and the
   existing 200-message result cap and per-message length clip.
4. **Raise the Telegram stored window explicitly** (a `history.thread` setting per chat, default
   unchanged until measured) rather than building a separate message store.
5. **Do not add an embeddings provider** until a measured need exists; if one is added, a keyword
   index comes first and message text never goes to a vendor without a per-bot opt-in in config.
6. **Slack-native search is opt-in and public-channel only**, behind its own config key, never a
   user token that can read beyond the dispatched chat.
7. **Never log queries or message text** in the poster, the MCP server or GitHub output, matching
   the existing chat context rules.

## Implementation plan

Each step lands with tests and docs.

1. Poster: `query`, `after` and `sender` on `read-channel`; `query` on `list-threads`; scanned-range
   fields in the result schemas; `docs/poster.md`.
2. MCP server: pass the arguments through, render the scanned range, and tell the agent in the
   prompt block that results come from a bounded window.
3. Config: any new keys (for example a Slack page cap) under `chat_context`, with
   `docs/config.md` and `test/config.test.ts` defaults.
4. Measure the Telegram window and Slack limits on a real install (**[HUMAN ACTION]**), then decide
   on phase 2 and 3.

## What could not be verified

- Slack limits for a single-workspace app on a real install; the lifetime of an `action_token`;
  whether a personal workspace has the AI features `assistant.search.context` requires.
- Current Voyage AI pricing and OpenSearch Serverless minimum cost (not fetched).
- Real chat sizes; the figures above are estimates.
- Cost of `appendToList` on a list of thousands of rows (the adapter queries the whole list to
  trim); read from source, not benchmarked.
