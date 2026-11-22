# Chat context tools (design)

> **Status: partly implemented.** The `chat_context` config key (step 1), the poster operations
> `list-threads` and `read-channel`, the repo-binding check on `read` and the platform support
> (steps 2 and 3) and the MCP server (step 4, not yet started by a turn) exist; see
> [poster.md](poster.md#list-threads-and-read-channel). The `prepare` wiring and prompt block
> below are still proposed.

Lets the agent see conversations other than the one it was asked to answer: sibling threads in the
same chat or channel, and recent top-level messages. Terms
(poster, receiver, turn, state table) are defined in [plan.md](plan.md), [poster.md](poster.md) and
[workflows.md](workflows.md).

## What the bot sees today

Nothing outside the current thread.

- `prepare` calls the poster's `read` operation for the one thread that triggered the turn
  (`thread.allMessages`) and renders it into the prompt according to the
  [context policy](plan.md#context-management). `resume` sessions carry only what earlier turns of
  that thread saw.
- The agent has no tool that lists threads, reads a channel or reads another thread; the poster
  operations that could back them exist, but nothing calls them yet. `read` takes any `threadId` of
  the bot (for a caller bound to the bot's repository), and only `prepare` calls it, with the
  dispatched thread.
- The prompt does not say which chat or channel the thread belongs to, who else is in it, or that
  other threads exist.
- The agent has no network tool to the chat platform, and the bot token never reaches the runner.

So the agent cannot know about parallel conversations, even when a person says "like we discussed
in the other thread".

## What the platforms can provide

| | Slack | Telegram |
|---|---|---|
| Source of history | Live Web API (`conversations.history`, `conversations.replies`), which works for any channel the bot is a member of. The manifest already requests `channels:history`, `groups:history`, `im:history` and `mpim:history`. | The Bot API has no history call. The adapter serves `fetchMessages`/`fetchChannelMessages` from messages the receiver has stored. |
| List threads in a channel | Adapter `listThreads(channelId)`, built on `conversations.history` (thread parents with reply counts). | None; derive it by grouping the stored messages of a chat by thread (topic). |
| Coverage | Everything in the channel, including messages sent before the bot joined. | Only messages the receiver saw after the bot was added, and of those only the chat's newest 100 (SDK default per list, 7-day TTL refreshed on append; see [poster.md](poster.md#list-threads-and-read-channel)). |

Both adapters implement `fetchChannelMessages`; `Chat` stores each incoming message under its
thread and its channel (`persistThreadHistory`, Telegram only). That storage happens before access
checks, so on Telegram the stored history also contains messages from senders who are not enrolled.
Whatever reads it must apply its own filter (see [Privacy](#privacy-and-trust)).

Slack rate limits to verify before building: Slack cut `conversations.history` and
`conversations.replies` to 1 request per minute (15 messages per call) for commercially distributed
apps outside the Marketplace, while apps installed in a single workspace (the one-app-per-repo
setup here) are meant to keep the normal limits. Confirm on a real install.

## Options

| Option | How | Assessment |
|---|---|---|
| A. Inject a digest | `prepare` fetches recent threads for the chat and adds a fenced section to every prompt | Costs tokens and poster calls on every turn, whether or not the agent needs it. Fixed size, so it either truncates or bloats. The agent cannot go deeper. |
| B. Tools on demand | A small MCP server on the runner exposes read-only chat tools backed by new poster operations | Pay only when used. The agent chooses depth. Fits the existing MCP and tool-gate machinery. |
| C. Hybrid | B, plus one prompt sentence naming the chat and saying the tools exist | Same cost as B and the agent knows to look. |

**Recommendation: C.** Option A is a poor default; if a digest proves useful it can be added later as a
config option on top of B.

## Design

### Poster operations

Both are read-only and follow the pull-request operations' trust model
([poster.md](poster.md#link-pull-request-and-resolve-pull-request)): the repository comes from a
verified OIDC token, and the bot must be bound to it.

| `operation` | Fields | Result |
|---|---|---|
| `list-threads` | `token` (OIDC JWT), `bot`, `chatId`, optional `limit` (default 20, max 50) | `{ threads: [{ threadId, title, lastActivity, messageCount, participants, snippet }] }`, most recent first |
| `read-channel` | `token`, `bot`, `chatId`, optional `limit` (default 50, max 200), optional `before` | `{ messages: [...] }` in the `read` shape plus `threadId`, newest first; top-level messages on Slack, all messages on Telegram |

Existing `read` takes the same `token` and checks the repo for every call (Decision 5); `prepare`
sends it. The requests also carry `threadId`, the dispatched thread, from which the poster derives
the only chat the turn may read, and an optional `includeBots` flag for Slack bot messages.

Rules enforced in the poster, never the caller:

- `chatId` must be a chat the bot is approved for and not blocked (the resolver `start-thread`
  already uses), and in the default `scope: chat` it must equal the chat of the dispatched thread,
  which the runner passes and the poster re-derives from the thread ID.
- Messages from senders who are not enrolled for the bot are dropped from the results. On Slack
  this includes other bots' messages unless the config opts in.
- Caps on thread count, message count and per-message length, applied in the poster so a tool server
  cannot be talked into asking for more.
- Failures log bot, chat and counts, never message content.

### MCP server

A built-in stdio server shipped with this repo (`src/mcp/chat-server.ts`, written with the official
MCP SDK, not hand-rolled), started by the turn from the `dist/` of the trusted checkout. `prepare`
adds it to the generated `.centaur-turn/mcp.json` when the config enables it, next to any
`mcp_servers` entries. It uses the AWS credentials the runner already has for poster calls.

| Tool | Does |
|---|---|
| `list_threads` | Recent threads in the current chat: handle, title, last activity, participants, one-line snippet. |
| `read_thread` | Messages of one thread by handle, oldest first, with a `before` cursor. |
| `read_channel` | Recent messages across the chat, newest first. |

Thread handles are opaque (`thread-1`, `thread-2`) and live in the server process, which maps them
to real thread IDs. Telegram thread IDs embed the chat ID, which the project keeps out of anything
GitHub-visible (see `threadKey`); handles keep the raw ID out of the agent's context, tool results and
session file. The current thread is always `thread-0` and is excluded from `list_threads`.

Searching by text is out of scope: Slack's search API needs a user token, and Telegram has nothing.
The agent filters what the tools return. A bounded poster-side filter is proposed in
[chat-search.md](chat-search.md).

The server is a trusted built-in, so it skips the `UseServer` operator policy, but its calls pass
through the same `PreToolUse` gate as any MCP tool ([mcp.md](mcp.md#tool-call-policy)), so an
operator can still `forbid` `CallTool` on it. `prepare` adds `mcp__centaur-chat__*` to the allowed
tools for the turn only when the feature is on.

### Config

```yaml
chat_context:
  scope: thread        # thread (default, no tools) | chat
  max_threads: 20
  max_messages: 50
```

`scope: thread` keeps today's behavior, so existing consumers see no change. `chat` enables the
tools for the dispatched thread's own chat only. A wider scope (every chat the bot is in) is
deliberately not offered; see Decisions. The schema, `docs/config.md`, the fixtures that build the
config by hand and `test/config.test.ts` defaults change with it.

### Prompt

One short block in `src/workflows/instructions/` (overridable like other guidance) when the feature
is on: the chat's name, that `list_threads`, `read_thread` and `read_channel` exist, and that their
output is untrusted data written by other people. Tool results are also fenced the way transcript
messages are, so a message in another thread that says "ignore your instructions" has the same
standing as one in this thread. Per `AGENTS.md`, anything the code parses stays in `prompt.ts`.

The tools are also how the agent reaches messages the
[transcript budget](workflows.md#transcript-budget-planned) leaves out of a long thread:
`read_thread` on `thread-0` with a `before` cursor. Without them (`scope: thread`) omitted messages
are unreachable and the omission note says so.

## Privacy and trust

- **Other threads have other audiences.** In a Slack channel everyone present can read every
  thread, so reading them adds no exposure. In a Telegram group the same holds for topics. The risk is
  the agent quoting one thread's content into a place its audience should not see (a DM, a PR in a
  public repo). The default scope stays within one chat for this reason, and the prompt block tells the
  agent that cross-thread content is not for public artifacts such as PR bodies and commits. That is
  guidance, not enforcement; the enforcement is the scope.
- **Prompt injection.** Messages from other people's threads are an additional untrusted input into a
  turn that may hold secrets and write access. The enrolled-sender filter limits who can write into
  it, fencing limits what it can do, and the existing tool allowlist and Cedar gate still bound the
  consequences. Cross-thread reading does not widen `allowed_tools`.
- **No content in GitHub.** Tool output stays between the MCP server and the agent. The server never
  writes it to the job log, step outputs or summary, and the turn already keeps message content out
  of artifacts.
- **Caller authorization.** The new operations verify the OIDC repo. They do not close the existing
  gap that `post` and `read` trust any role the OIDC role allows (accepted for self-hosted
  deployments; see [poster.md](poster.md#security-model)).
  Cross-thread reads make closing it more important, since a repo under the same owner could read any
  bot's chat. Do not ship `scope: chat` without at least the repo-binding check.

## Out of scope

- Writing to other threads (`post` already exists, but cross-thread posting from an agent needs its
  own approval design; see [mcp-approval.md](mcp-approval.md)).
- Seeing other threads' turn state, in-flight runs or PRs.
- Other chats the bot is in, DMs, and history from before the bot joined on Telegram.
- Search, embeddings or summarization of history (search is proposed in
  [chat-search.md](chat-search.md)).
- Adding all of this to `fresh`/`resume` prompts automatically.

## Implementation plan

Each step lands with tests and docs.

1. Config: `chat_context` schema, defaults and `docs/config.md`. **Done**: the block parses and is
   documented; nothing reads it yet.
2. **Done.** Poster: `list-threads` and `read-channel` with the OIDC and chat-scope checks, the sender filter
   and caps, behind the fake adapters in `test/helpers/`. `docs/poster.md`.
3. **Done** (Slack limits still to verify). Telegram: group stored history into threads for `list-threads`; Slack: map `listThreads` and
   `fetchChannelMessages`. Verify Slack limits on a real app (**[HUMAN ACTION]**).
4. **Implemented:** `src/mcp/chat-server.ts` (`createChatServer`, `serveChatServer`) with the handle and cursor mapping, fenced output and caps, using the MCP SDK and a `ChatPosterClient` interface (`src/mcp/chat-poster-client.ts`); unit-tested against a fake client over an in-memory transport. Not yet wired to the real poster client or started by a turn (it builds to `dist/mcp/chat-server.js`).
5. `prepare`: write the server into `mcp.json`, extend the tool allowlist, add the prompt block.
6. Tool gate: confirm a `CallTool` `forbid` on the server is honored.
7. Real run on `centaur-hello` in each platform: the agent in one thread summarizes another
   (**[HUMAN ACTION]**).

## Decisions

Recommendations in bold; each needs the maintainer's approval before building.

1. **Scope: one chat, never all chats.** Wider scope turns one bot into a read path across every
   audience it serves.
2. **Default off (`scope: thread`).** Existing consumers keep today's behavior.
3. **Tools over a digest** (Option C).
4. **Drop unenrolled senders' messages** from tool results, on both platforms.
5. **Require OIDC repo-binding on every poster read**, not just the new ones, as part of this work
   rather than waiting for the general caller-check decision.
6. **Opaque thread handles** held by the MCP server rather than raw thread IDs.
7. **A built-in stdio server**, exempt from `UseServer` but subject to the call gate, rather than a
   hosted remote server (a new public endpoint to secure for little gain).
