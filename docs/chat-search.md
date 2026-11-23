# Searching chat history

> **Status: decisions accepted (2026-11-22); step 1 (the `scanned` range in poster results) is
> implemented, the rest is not built.** See the [Implementation plan](#implementation-plan). It
> extends [chat-context.md](chat-context.md), which keeps search out of scope, and feeds the bounded transcript ([workflows.md](workflows.md#transcript-budget)). Terms (poster,
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
- **Accepted plan:** no poster-side filter, because the poster scans the whole window anyway and the
  Telegram window fits in one `read_channel` call. Every result reports the scanned range, and
  Slack-native search is added as an opt-in, Slack-only, public-channel slice for deep lookups. No
  secondary index of any kind (no SQLite FTS, OpenSearch or embeddings): the extra infrastructure
  cost is not wanted for now.

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
- **Consequence for the reader.** The stored window bounds the scan: the channel list holds at most
  its `maxLength` rows (100 by default), so on Telegram the reader sees at most that many of the
  chat's newest messages, and `list-threads` groups only those. The TTL is
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
| a | No search; agent filters (**accepted**, with the scanned range reported) | Widen existing `read_channel`/`read_thread` filters (`before`, `after`, `sender`) and let the agent page | Tokens: every page the agent reads goes into context. Latency: one poster call per page. | Nothing new | None | Agent gives up early or burns context paging; on Telegram it can never go past 100 messages |
| b | Poster-side substring filter (**rejected for now**: the poster scans the whole window anyway, and the Telegram window fits in one `read_channel` call) | `query` (case-insensitive substring, per message, whole-word optional) applied after the sender filter over the window the reader already scans (Telegram: stored list; Slack: up to N `conversations.history` pages, default 3, max 10) | Same reads as today; filter is free. Slack pages are 1 call each (rate limited). | Query and text stay in the poster and the MCP server; nothing in logs | None | Misses anything outside the window, says nothing about it unless the result states the scanned range; no stemming or ranking; Slack rate limits |
| c | Keyword index (**rejected**: extra infrastructure cost not needed for now) | (c1) Per-request in-memory index over a bounded window: build SQLite FTS5 (or MiniSearch) in the poster from the scanned messages, query, discard. (c2) Managed: OpenSearch Serverless, or a separate store fed by the receiver. | c1: no new storage, adds a native or WASM dependency to the Lambda bundle and CPU per request; useless when the window is the bottleneck, since it indexes what b already scans. c2: OpenSearch Serverless has a minimum standing cost (several hundred dollars a month at list; not verified) and VPC or IAM setup. | c2 puts message text in a second store that needs its own retention and deletion | c1 low. c2 high, out of proportion for a self-hosted single-owner stack | c1: only as good as the window. c2: index lag, deletion drift (edited or deleted messages must be reindexed), extra credentials |
| d | Semantic search (embeddings) (**rejected**: extra infrastructure cost not needed for now) | Embed each message at receive time (or lazily on first search), store vectors, rank by cosine similarity; optionally rerank | Anthropic has no embeddings model ("Anthropic does not offer its own embedding model", <https://platform.claude.com/docs/en/build-with-claude/embeddings>), which names Voyage AI (`voyage-4-lite` for cost, `voyage-4` balanced, 1024 dims by default, 256 to 2048 selectable, `input_type` of `document` or `query`, unit-normalized so dot product equals cosine) via MongoDB Atlas model API keys (`https://ai.mongodb.com/v1/embeddings`) or AWS Marketplace. Pricing: see the Voyage page (not fetched). One embedding call per message at receive time puts a third-party call on the receiver's critical path unless done asynchronously. | Every message text leaves the AWS account to the embedding vendor, including from unenrolled senders unless filtered before embedding; a new data processor to disclose. Vectors are reversible enough to treat as message content. | New secret, new SDK, a vector store (DynamoDB rows of 4 KB per 1024-float32 vector, or int8 and 256 dims for 256 B; brute-force cosine over a bounded set in the poster is fine up to tens of thousands of vectors, beyond that a vector index such as OpenSearch is needed), a backfill job, and deletion that follows message deletion and TTL | Vendor outage or rate limit stalls indexing; model change invalidates all vectors; embeddings miss exact tokens (IDs, error strings), which keyword search handles; Telegram history before the feature ships is not backfillable beyond the 100 stored |
| e | Slack-native search (**accepted** as an opt-in slice, bot token and `action_token` only; the `search.messages` user-token variant is rejected) | Poster calls `assistant.search.context` with the bot token and a forwarded `action_token` (public channels), or `search.messages` with a per-user token stored in SSM | No storage. Rate limited (about 10 per minute); results include permalinks and context messages. | Slack searches its own data; results follow the token's visibility, so a user token can surface messages from channels the bot is not in, which breaks the one-chat scope | Manifest scopes, a `action_token` through dispatch, or an OAuth user-token flow; Slack-only | Token expiry mid-turn, workspace without the feature, cross-chat leakage, no Telegram equivalent so behavior differs by platform |

Ranking and quality, briefly: substring matching returns matches newest first, which is enough for
"find where we discussed X" in a short window. Keyword indexes add stemming and BM25. Embeddings help
paraphrase queries and cost exact-token recall; the usual pairing is keyword plus vectors with a
reranker, which is more than this project needs now.

## Recommendation

Accepted phasing. Every step is cheap to run and adds no standing infrastructure.

1. **Report the scanned range.** Every `read-channel` and `list-threads` result states the oldest
   message examined and whether the window was exhausted, so the agent knows how far back it saw
   and an empty result is never mistaken for "does not exist". No poster-side `query`, `after` or
   `sender` filter: the poster scans the whole window anyway, and the Telegram window fits in one
   `read_channel` call, so the agent filters the result itself.
2. **Raise Telegram's stored window explicitly.** The 100-message channel list is the binding
   constraint on Telegram, not search. Set `history.thread` (`maxMessages`, `ttlMs`) explicitly for
   the Telegram adapter's chat, with the cost noted above (the adapter reads the whole list on every
   append, which should be measured before going to thousands). Tracked separately.
3. **Slack-native search (Option e), opt-in.** Behind its own config key, public channels only, via
   `assistant.search.context` with the bot token and a forwarded `action_token`. It needs no storage
   and no new data processor, and it covers deep lookups in Slack history.

Not planned, kept as rejected alternatives: b (poster-side filter, rejected for now for the reason
above), and c1 (per-request SQLite FTS5 or MiniSearch), c2 (OpenSearch Serverless or another store
fed by the receiver) and d (embeddings), rejected because the extra infrastructure cost is not needed
for now. These can be revisited if one of these holds: a chat whose history regularly exceeds a
scannable window (more than a few thousand messages the agent must search); measured agent behavior
showing it pages many times to find things; a hosted multi-tenant mode (TODO "Explore a hosted
option"), where a shared index, per-tenant isolation and data-processor disclosure become central;
Slack granting unrestricted search to bot tokens; or Anthropic shipping embeddings.

## Bounded transcript interaction

The omission note in [workflows.md](workflows.md#transcript-budget) points the agent at
`read_thread` with `before`. The agent finds older messages that note dropped by paging with
`read_thread` and `before`, or, on Slack with the opt-in enabled, by searching. The search tool
must not widen `scope`: it reads the dispatched thread's own chat only.

## Decisions

Accepted by the maintainer on 2026-11-22.

1. **No poster-side search filter.** The poster scans the whole window anyway, and the Telegram
   window fits in one `read_channel` call, so a filter would save the agent nothing.
2. **Report the scanned range** (oldest message examined and whether the source was exhausted) in
   every `read-channel` and `list-threads` result.
3. **No separate search infrastructure for now.** No SQLite FTS, OpenSearch or embeddings.
4. **Raise the Telegram stored window explicitly** (a `history.thread` setting per chat, default
   unchanged until measured) rather than building a separate message store.
5. **Do not add an embeddings provider** until a measured need exists; if one is added, a keyword
   index comes first and message text never goes to a vendor without a per-bot opt-in in config.
6. **Slack-native search is included, opt-in and Slack-only.** It sits behind its own config key
   (off by default), searches public channels only with `assistant.search.context`, the bot token
   and a forwarded `action_token`, never a user token, and never beyond the dispatched chat (results
   are restricted to the chat's channel, and anything else is dropped in the poster).
7. **Never log queries or message text** in the poster, the MCP server or GitHub output, matching
   the existing chat context rules.

## Implementation plan

Ordered slices; each lands with tests and docs.

| # | Slice | Depends on | Files | Status |
|---|---|---|---|---|
| 1 | Poster: `scanned: { oldest, exhausted }` in `read-channel` and `list-threads` results | none | `src/lambda/chat-context.ts`, `docs/poster.md`, `test/chat-context.test.ts`, `test/helpers/chat-context-fixtures.ts` | done |
| 2 | Config key under `chat_tools`: the Slack-native search opt-in | none | `src/config/`, `docs/config.md`, `test/config.test.ts` | open |
| 3 | MCP server: render `scanned` in `read_channel` and `list_threads` output, and tell the agent in the prompt block that results come from a bounded window | 1 | `src/mcp/chat-server.ts`, `src/mcp/chat-poster-client.ts`, `src/workflows/` prompt block, `docs/chat-context.md` | open |
| 4 | Slack-native search: receiver captures the `action_token`, poster operation `search-chat`, MCP `search_chat` tool | 2, 3 | see below | open |
| 5 | Telegram stored-history window (`history.thread`) | none | `src/lambda/chat.ts`, `infra/`, docs | separate worker |
| 6 | Verify on a real install: Slack rate limits for a single-workspace app, `action_token` lifetime, AI-feature availability, Telegram window cost | 4, 5 | none | open, **[HUMAN ACTION]** |

`scanned.exhausted` is `true` when the source (the stored Telegram list, or the one Slack page with no
older cursor) was fully read, and `false` when the read stopped at `limit` or Slack reported an
older page.

### Slice 4: design questions to settle first

- **Where the `action_token` is captured.** The Slack adapter's `SlackEvent` type and the Chat SDK
  have no `action_token` field or handling (checked in `node_modules`: no occurrence in
  `@chat-adapter/slack` or `chat`). Whether Slack includes it in the `message` and `app_mention`
  event bodies the receiver gets is the first thing to verify against a real event; if so, the
  receiver can read it from the message's `raw` event (an untyped record, so a runtime check is
  needed) when it dispatches. If it is not in the event, the slice stops here.
- **How it reaches the poster without the GitHub-visible dispatch payload.** The
  `repository_dispatch` payload is readable in GitHub, and the token grants search as the bot, so
  it must not go there. Store it in the state table with a short TTL, keyed by bot and thread key
  (`src/thread-key.ts`), written by the receiver when it dispatches. The poster reads it by the
  verified bot and the dispatched thread (not a caller-supplied key), so a turn can only use the
  token of its own thread. Overwrite on every new message; never return it in a response.
- **Manifest scopes** in `docs/slack-app-manifest.yml`: `search:read.public` only (see
  [Slack search requirements](#slack-search-requirements)). No `search:read.private`, `.im`,
  `.mpim`, `.files`, `.users` or user-token scope. Existing installs must re-authorize after the
  manifest changes; the opt-in config key stays off until they do.
- **Token lifetime and degradation.** The lifetime is undocumented on the API page (unverified). The
  poster treats an absent, expired or rejected token as "search unavailable": it returns a result
  that says so (not an error and not an empty match list), and the MCP tool tells the agent to
  fall back to `read_channel`. A turn that outlives the token degrades the same way. Rate limit
  responses are surfaced the same way, without retrying.
- **Scope restriction.** Request public channels only and the dispatched channel only (a `channel`
  filter on the call), then drop any result whose channel differs. Results carry permalinks and
  context messages, which pass the same enrolled-sender filter and length clip as other reads. Never
  log the query, token or results.

## Slack search requirements

Read from the raw Slack docs on 2026-11-22:
[assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context),
[Real-time Search API guide](https://docs.slack.dev/apis/web-api/real-time-search-api),
[app manifest reference](https://docs.slack.dev/reference/app-manifest),
[installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth).

- **Bot scopes.** Method page: "Bot token: search:read.files search:read.public
  search:read.users". Guide: "Your app must contain at least the search:read.public scope and can
  optionally contain any of the scopes following that". So `search:read.public` alone is the
  minimum, and the manifest adds only it. The `.private`, `.mpim` and `.im` scopes are user-token
  only, and `.files` and `.users` are optional, so none is needed.
- **Public-only.** `channel_types` "Default: public_channel". Searching from a public channel
  "will only return results from public channels"; from a private channel or MPDM it also returns
  that conversation, so the poster must pass `public_channel` and drop other channels' results.
  `search:read.public` covers "all public channel messages" in the workspace, not only channels the
  bot has joined, so the one-chat restriction is ours (Decision 6).
- **`action_token`.** "All API calls made using a bot token require an action_token." It arrives in
  `app_mention` ("when the app is mentioned"), and in `message.im`, `message.mpim`,
  `message.groups` and `message.channels` (the last "when the app is mentioned"); in a DM no
  mention is needed. "The app must be subscribed to at least one of these events." The manifest
  already subscribes to all of them, so no event change is needed. Lifetime: not documented; the
  error `invalid_action_token` reads "not valid, has expired, or was not issued to the app".
- **Availability.** The guide says RTS "is available for directory-published apps and internal
  apps only" and that guests cannot use it. The method page calls it usable "with an app using AI
  features" ([/ai](https://docs.slack.dev/ai/)); it does not say which manifest feature that
  means. `features.agent_view` (`assistant_view` is legacy) turns the Messages tab into an agent
  conversation view, which would change how the bot's DMs look, so the manifest does not add it.
- **Applying a scope change.** Installing again is additive: "each installation can result in
  additive scopes" assigned "to the token". Every response carries an `x-oauth-scopes` header
  listing the calling token's scopes.
- **Data terms.** "You must not store or copy any of the data retrieved from this API."

Open questions for the maintainer:

1. Does `assistant.search.context` work with a bot token without `features.agent_view`? If not,
   adding it changes the Messages tab for existing features. Unverified; test with only the scope
   first.
2. The no-store rule: the agent's turn reads results into the model context and the workflow
   transcript. Confirm that is acceptable, and that results are never persisted (state table,
   PR text, artifacts).

## What could not be verified

- Slack limits for a single-workspace app on a real install; the lifetime of an `action_token`;
  whether Slack puts it in the event bodies the receiver gets (the docs say it does for the events
  above, but this has not been seen on a real event); whether a personal workspace has the AI
  features `assistant.search.context` requires; whether `search:read.public` suffices without an
  agent view; whether the bot token string is unchanged after a reinstall (the OAuth doc implies
  it, since scopes are added to the token).
- Current Voyage AI pricing and OpenSearch Serverless minimum cost (not fetched).
- Real chat sizes; the figures above are estimates.
- Cost of `appendToList` on a list of thousands of rows (the adapter queries the whole list to
  trim); read from source, not benchmarked.
