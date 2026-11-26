# Chat context tools (design)

> **Status: implemented behind `chat_tools.scope: chat`, not yet run against a real chat.** The
> config key, the poster operations (`list-threads`, `read-channel`, the repo-binding check on
> `read`), the platform support, the MCP server and its stdio entry, the `prepare` wiring and the
> prompt block exist; see [poster.md](poster.md#list-threads-and-read-channel). Open: the live
> confirmation of the tool gate (see [Tool gate](#tool-gate)), and the live test on each platform.
>
> This repo's own `.centaur/config.yml` enables `scope: chat` for the live run.

Lets the agent see conversations other than the one it was asked to answer: sibling threads in the
same chat or channel, and recent top-level messages. Terms
(poster, receiver, turn, state table) are defined in [plan.md](plan.md), [poster.md](poster.md) and
[workflows.md](workflows.md).

## What the bot sees by default

Nothing outside the current thread (`chat_tools.scope: thread`, the default).

- `prepare` calls the poster's `read` operation for the one thread that triggered the turn
  (`thread.allMessages`) and renders it into the prompt according to the
  [context policy](plan.md#context-management). `resume` sessions carry only what earlier turns of
  that thread saw.
- The agent has no tool that lists threads, reads a channel or reads another thread. `read` takes any
  `threadId` of the bot (for a caller bound to the bot's repository); `prepare` calls it with the
  dispatched thread, and with `scope: chat` the chat server also calls it for threads it listed.
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
| Coverage | Everything in the channel, including messages sent before the bot joined. | Only messages the receiver saw after the bot was added, and of those only the chat's newest `HistoryMaxMessages` per list (default 100), expiring `HistoryTtlDays` (default 7) after the latest append; see [poster.md](poster.md#list-threads-and-read-channel). Each append reads the whole list to trim it: 20 ms at 100 messages, 31 ms at 1000 and 109 ms at 5000 on DynamoDB Local. Assuming 1 KB per stored message and two lists per message, that is about N/2 strongly consistent read units, roughly $0.000006 per message at 100, $0.00003 at 500 and $0.0003 at 5000 on-demand (estimate), plus about $0.000004 of writes. |

Both adapters implement `fetchChannelMessages`; `Chat` stores each incoming message under its
thread and its channel (`persistThreadHistory`, Telegram only). That storage happens before access
checks, so on Telegram the stored history also contains messages from senders who are not enrolled.
Whatever reads it must apply its own filter (see [Privacy](#privacy-and-trust)).

**Bot posts on Telegram.** `Chat` appends an incoming message to the thread's list and the chat's
list, but the bot's own posts only to the thread's list, so the poster appends each message it posts
to the chat's list too (`postInThread` in `src/lambda/channel-history.ts`), and the chat tools
list them. Posts made before that was added are in their thread's list only, so the chat tools omit
them, and threads only the bot wrote in, until the history window passes. The chat tools read the chat
list through `chat.history.thread.collect(channelId)`: the SDK's `chat.channel(id).messages` and
`history.channel.listMessages` never read the stored list, because the Telegram adapter's
`fetchChannelMessages` compares `decoded.chatId` with `telegram:<chatId>` and matches nothing (an SDK
bug the reader works around). Slack reads live and is unaffected.

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

A failed request returns `The chat request failed: <detail>` and writes `centaur-chat: <tool> failed:
<detail>` to the server's stderr. `<detail>` is the first line (200 characters) of a `SafeError`
message (`src/workflows/safe-error.ts`: poster failures, the failed `aws lambda invoke` reduced to the
CLI's first stderr line or spawn code, OIDC token errors, an unknown cursor) and otherwise only the
error's class name, because any other message might echo chat content.

Searching by text is out of scope: Slack's search API needs a user token, and Telegram has nothing.
The agent filters what the tools return. A bounded poster-side filter is proposed in
[chat-search.md](chat-search.md).

The server is a trusted built-in, so it skips the `UseServer` operator policy. `prepare` adds it to
`mcp.json` and `mcp__centaur-chat__*` to `--allowedTools` for the turn only when `scope` is `chat`
and the turn has a dispatched thread (a scheduled turn or a `/new` seed has none); a configured
server of the same name fails the turn. What bounds its calls today is described under
[Tool gate](#tool-gate).

#### Runner side

`prepare` writes the server as `node <dist>/mcp/chat-server-main.js`, where `<dist>` is the build
next to the running `prepare` (`CHAT_SERVER_ENTRY` in `src/workflows/mcp-config.ts`). That is the
Centaur action's checkout, which the `turn` action runs `prepare` from; it is never the workspace,
so a pull request cannot substitute the entry code, on comment turns too. The `env` in `mcp.json`
holds the turn state directory (outside the workspace), the two limits and `${NAME}` references to
the poster settings and the AWS credentials the runner already has, so the file holds no
secret and no thread ID. The entry reads the bot and the dispatched thread from the turn state,
derives the chat from the thread ID (the poster re-derives it and rejects a mismatch), fetches a
fresh OIDC token for every call and invokes the poster like the other runner steps. It writes only
the MCP protocol to stdout and logs nothing but its startup errors to stderr, never message text or
the thread ID.

**OIDC credentials.** The agent action deletes `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` from the environment it gives Claude Code, and `mcp.json` sits in
the workspace where the agent can read it, so neither can be forwarded to the server. `prepare`
runs in a plain step that still has them and, when chat tools are on, writes both to
`oidc-credentials.json` in the turn state directory (directory 0700, file 0600, outside the
workspace; the path comes from `RUNNER_TEMP` alone, so a pull request branch cannot move it). The
server reads the file on every call and mints a token (valid for 300 s) for the poster audience; a
missing or malformed file fails the call with "OIDC credentials unavailable". The request token can
mint tokens for any audience for the rest of the job, the same exposure class as the forwarded
`AWS_*` credentials: anything running as the runner user, including the agent's shell tools, can
read the file.

The poster pages `read-channel` by instant and the server's cursors stand for message IDs, so the
client (`src/mcp/poster-chat-client.ts`) remembers the send time of every message it returns and
sends that as `before`. The poster's `read` has no `before` and returns the thread oldest first, up
to the stored window of 100 messages, so `read_thread` pages inside the client: it drops messages
sent at or after the cursor, keeps the newest `limit` and reports the range it returned.
`scanned.exhausted` is true only when the page reaches the start of a stored list shorter than 100
messages. Text is clipped to the poster's 4000-character cap. Every result ends with a line such as
`scanned back to <time>, window exhausted: no`.

### Config

```yaml
chat_tools:
  scope: thread        # thread (default, no tools) | chat
  max_threads: 20
  max_messages: 50
  slack_search: false  # opt-in Slack-native search; needs scope: chat and the slack platform
```

`scope: thread` keeps today's behavior, so existing consumers see no change. `chat` enables the
tools for the dispatched thread's own chat only. A wider scope (every chat the bot is in) is
deliberately not offered; see Decisions. The schema, `docs/config.md`, the fixtures that build the
config by hand and `test/config.test.ts` defaults change with it.

### Prompt

One short block, `src/workflows/instructions/chat_tools.md` (overridable as `instructions.chat_tools`),
is included in chat and pull request comment turns when the feature is on: that `list_threads`,
`read_thread` and `read_channel` exist, that their output is untrusted data written by other people,
that results cover a bounded window, and
(when the skills are installed) that the `centaur-chat-tools` skill explains paging with cursors and
how to read the window each result reports. The chat's name is not included: no source provides one. Tool results are also fenced the way transcript
messages are, so a message in another thread that says "ignore your instructions" has the same
standing as one in this thread. Per `AGENTS.md`, anything the code parses stays in `prompt.ts`.

The tools are also how the agent reaches messages the
[transcript budget](workflows.md#transcript-budget) leaves out of a long thread: `read_thread` on
`thread-0` with a `before` cursor, which the omission note names. Without the tools
(`scope: thread`) omitted messages are unreachable and the note says so.

## Tool gate

The per-call `CallTool` gate (a Claude Code `PreToolUse` hook that evaluates operator Cedar policy
per call, [Tool-call policy](mcp.md#tool-call-policy)) covers this server when the config also has
`mcp_servers`, because the hook is installed only then. For this server that means:

- **Enforced:** the server runs only when `chat_tools.scope` is `chat` and the turn has a
  dispatched thread; its tools are in `--allowedTools` for that turn only (`mcp__centaur-chat__*`);
  the poster enforces the OIDC repo binding, the approved chat, the dispatched-thread chat, the
  sender filter and the caps whatever the server asks for. With `mcp_servers` set, an operator
  `forbid` on `CallTool` for `centaur-chat` or one of its tools refuses the call (unit-tested against
  the server's registered tool names).
- **Not enforced:** a `CallTool` `forbid` on a config with no `mcp_servers`, which installs no hook;
  the `UseServer` check does not apply to the chat server either. To disable the tools, set
  `scope: thread`.
- **To confirm live:** that the denial reaches the agent as a tool error under
  `claude-code-action`.

## Privacy and trust

- **Other threads add no exposure.** In a Slack channel everyone present can read every thread, so
  reading them adds no exposure. In a Telegram group the same holds for topics. The boundary is the
  scope (one chat per turn) and which chats the bot is enrolled in; a bot per channel is the
  recommended way to separate audiences. The prompt has no rule about where cross-thread content may
  go, so the agent may use it in pull requests, commits and files. A repository that is public while
  its channel is private is the repository owner's configuration to avoid; a config option could be
  added if that is ever needed.
- **Prompt injection.** Messages from other people's threads are an additional untrusted input into a
  turn that may hold secrets and write access. The enrolled-sender filter limits who can write into
  it, fencing limits what it can do, and the existing tool allowlist and Cedar gate still bound the
  consequences. Cross-thread reading does not widen `allowed_tools`.
- **Reads of other threads are sender-filtered.** `read_thread` sends the poster's `read` with `visibleOnly: true`, which applies the same filter as `list-threads` and `read-channel` and requires the thread's chat to be approved. Rollout: a runner that sends `visibleOnly` to a Lambda that predates it is rejected by the strict request schema, so deploy the Lambda first; only `scope: chat` turns are affected.
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

1. Config: `chat_tools` schema, defaults and `docs/config.md`. **Done**: the block parses and is
   documented; nothing reads it yet.
2. **Done.** Poster: `list-threads` and `read-channel` with the OIDC and chat-scope checks, the sender filter
   and caps, behind the fake adapters in `test/helpers/`. `docs/poster.md`.
3. **Done** (Slack limits still to verify). Telegram: group stored history into threads for `list-threads`; Slack: map `listThreads` and
   `fetchChannelMessages`. Verify Slack limits on a real app (**[HUMAN ACTION]**).
4. **Done.** `src/mcp/chat-server.ts` (`createChatServer`, `serveChatServer`) with the handle and cursor mapping, fenced output and caps, using the MCP SDK and a `ChatPosterClient` interface; unit-tested against a fake client over an in-memory transport.
5. **Done.** The poster-backed client, the stdio entry `src/mcp/chat-server-main.js` (spawned-process test against a fake `aws` and token endpoint), `prepare` writing the server into `mcp.json`, extending the allowlist and adding the prompt block; `dist/` builds it and the Lambda bundle does not contain it.
6. **Partly done.** The per-call gate honors a `CallTool` `forbid` on `centaur-chat` (unit-tested; see [Tool gate](#tool-gate)), but only for a config with `mcp_servers`. Open: the live confirmation under `claude-code-action`.
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
