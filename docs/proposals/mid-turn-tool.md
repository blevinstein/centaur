# Mid-turn messages: progress updates and questions

Status: **proposal**. Nothing here is built. It extends the built-in `centaur-chat` MCP server
([chat-context.md](../chat-context.md)) and the poster ([poster.md](../poster.md)), and is the plan
behind the backlog item in [TODO.md](../../TODO.md#backlog). Terms (turn, poster, receiver, marker)
are defined in [workflows.md](../workflows.md) and [plan.md](../plan.md).

## Problem

A turn speaks once: `finish` posts the structured `reply` after the agent exits. A turn can run
for up to 30 minutes (`timeout-minutes` on the turn job) and 30 agent turns (`max_turns`), and the
person in the thread sees only the 👀 reaction meanwhile. Two needs follow:

1. **Progress.** "Found the failing test, fixing it now" before a long build, so a person can tell a
   working turn from a stuck one, or cancel early.
2. **Questions.** The agent hits a real fork ("two config files match; which one?") and today can
   only guess or end the turn with a question as its reply.

The second need does not need a new mechanism, only guidance (see [Questions](#questions-and-how-the-answer-comes-back)).
The first does: nothing the agent can call posts into the thread before `finish`. The agent has no
chat token and must not get one (the bot token never reaches the runner), so the post has to go
through the poster, as the chat tools already do.

## Design

### Tool

One tool on the `centaur-chat` server:

| Tool | Input | Result |
|---|---|---|
| `post_update` | `text` (string, 1 to 600 characters after trimming) | `Posted.` or `Not posted: <reason>` (limit reached, text rejected) |

No thread, chat or user parameter: the server posts to the dispatched thread it already reads from
the turn state, the way `read_thread` resolves `thread-0`. The agent cannot name another thread, so
"never another chat" holds by construction in the server and is enforced again in the poster. The
text is plain text, like `reply` on chat turns.

A second tool, `ask_thread`, is considered and not recommended ([Decision 3](#decisions)).

### Where it lives and the opt-in

Extend `centaur-chat` rather than add a server. It already has the stdio entry, the OIDC
credentials file, the poster-backed client, the turn-state reading and the `CallTool` gate wiring; a
second server would duplicate all of it (and `mcp_servers` would still refuse the reserved name).
Its tool set today follows `chat_tools.scope`; this adds an independent switch:

```yaml
chat_tools:
  scope: thread        # unchanged: gates the read tools only
  progress: false      # opt-in: the post_update tool, own thread only
  max_updates: 5       # per turn, 1 to 20
```

`progress` is independent of `scope`: posting to your own thread widens nothing about what the
agent can read, and a bot that only wants progress should not have to turn on cross-thread reading.
`prepare` starts the server when either is on, registers only the enabled tools, and adds exact
`mcp__centaur-chat__<tool>` entries to `--allowedTools` for them (the `mcp__centaur-chat__*`
wildcard stays for `scope: chat`, which now has to be read as "the tools the server registered").
Like the read tools it needs a dispatched thread: a scheduled turn or a `/new` seed has none, so
the tool is not registered there and the prompt says nothing about it. Config schema, defaults,
`docs/config.md` and the hand-built config fixtures change with the key.

### Poster operation

A new operation, not a loosened `post`: `post` takes any thread of the bot and an optional token, which
is the wrong trust model for something an agent drives.

| `operation` | Fields | Result |
|---|---|---|
| `post-update` | `token` (GitHub OIDC JWT, required), `bot`, `threadId` (the dispatched thread), `text` (1 to 600 characters) | `{ messageId }` |

Checks, all in the poster, none delegated to the server:

1. **Caller.** `requireBound` on the token and bot, as `read-channel` and `search-chat` do: the bot
   must be bound to the verified repository. The token is mandatory whatever `REQUIRE_POSTER_TOKEN` says.
2. **Chat.** The chat of `threadId` must be approved for the bot and not blocked (the resolver
   `read-channel` uses). The thread must belong to the bot: it has a stored transcript or a
   `thread-meta` record. A thread the bot never spoke or listened in is rejected, so a request cannot
   be used to open a conversation in a chat by guessing an ID. (`start-thread` is the only operation
   that creates threads.)
3. **Text.** Trimmed, clipped to 600 characters (the clip is a hard error over the cap in the
   request schema, and the server clips before sending so the agent sees "clipped" rather than an
   error), mentions neutralized (below), control characters removed.
4. **Rate.** A per-thread counter in the bot's state (`progress-count:<threadKey>`, conditional
   increment, 1 hour TTL) caps the thread at the configured maximum times a small factor (default 20
   per hour, a constant in code). The poster does not know the turn's `max_updates` (the OIDC token
   carries only the repository), so the per-turn cap is the server's job and the per-thread hourly cap
   is the poster's backstop against a loop in a compromised or buggy server.
5. **Posting.** Through `postInThread`, so the update lands in the stored transcript (and, on
   Telegram, the chat-level list) and a later turn sees what the bot already said. Posts are
   sent as the bot, with no reply-to.

The operation never reads the thread and returns no content.

**Sender filters.** Not applicable on the way out; the relevant filter is on the way in: a post by the
bot is its own message, ignored by the receiver (the SDK drops self messages, and `ownership.ts`
only admits other bots' messages under `bot_messages: mention`). A test pins that an update does not
dispatch a turn on its own bot.

### Limits against spam and cost

- **Count.** `max_updates` per turn (default 5), enforced in the server's process; the 6th call
  returns `Not posted: update limit reached` without calling the poster, and the agent is told
  the limit in the prompt.
- **Length.** 600 characters, one message; no attachments, no formatting beyond what the platform
  renders from plain text.
- **Rate.** The poster's per-thread hourly cap above. The server also refuses an update within 15
  seconds of the previous one (returns `Not posted: wait`), so a tight loop costs the agent a turn
  rather than the thread a flood.
- **Cost.** Each call is one agent step (counts toward `max_turns`) plus one Lambda invocation.
  The prompt guidance asks for updates only before steps that take minutes.
- **Mentions.** The poster rewrites rather than rejects: Slack `<@U..>`, `<!channel>`, `<!here>`,
  `<!everyone>`, `<!subteam^..>` and `<#C..>` lose their markup and render as plain words;
  Telegram `@name` gets a zero-width space after the `@` so it does not ping, and `tg://user`
  links and `text_mention` entities are never produced because the post is plain text. The agent
  cannot ping anyone with an update; a person it needs is named in words. The final `reply` is
  untouched.
- **Redaction.** The repository has no secret scrubber today and this does not add a hand-rolled
  one. The mitigation is structural: the tool takes only text the agent wrote, never a tool result by
  reference; the length cap bounds a paste; the prompt says never to quote file contents,
  environment values or tool output in an update. The residual risk (an agent pasting a secret it
  read) is the same as for `reply`, and the thread's audience is the same. See
  [Decision 6](#decisions) for an optional pattern pass.

### Questions and how the answer comes back

A turn cannot block on chat: the agent process runs inside a GitHub Actions job with a 30 minute
cap and no channel from the Lambda back into it; the receiver dispatches a workflow per message and
never wakes a running one. Holding a job open for a person to answer would also burn runner minutes
and the spending cap while idle.

So a question is the **end of a turn**, which already works:

1. The agent returns a `reply` that asks the question, as the final answer of this turn. `finish`
   posts it, removes the 👀 reactions, advances the marker and (for `resume` threads) saves the
   session, exactly as for any answered turn. Nothing new is built for this.
2. The person answers in the thread. The receiver dispatches a normal next turn for that message.
   On a `resume` thread the agent continues with its earlier session (it sees its own question and the
   answer); on `transcript` and `fresh` threads it sees the question as its own earlier message in
   the transcript (`fresh` sees only the new message, which is why guidance asks for a question
   that stands alone and states what the agent already found).
3. Work done before the question stays in the workspace only if the turn pushed it: changes are
   committed and a pull request opened as for any turn, so a question asked after partial edits ends
   in a pull request link with the question. The prompt tells the agent to ask before editing when
   the answer decides the edit.

The existing `suspend_for` machinery is **not** reused. It exists because an approval decision is an
event with no message in the thread to dispatch on; the admin's decision re-dispatches the thread
with a record keyed to the pending server. A question has a message to dispatch on already (the
answer), so a suspend would add a record, a reaction and a race for nothing, and it would leave the
marker behind so the thread replays old messages. The cost of the plain route is that a question
cannot attach to a *specific* pending message, and nothing stops a person answering after the next
unrelated message; that is how every other reply in a thread works.

If the maintainer wants the explicit tool ([Decision 3](#decisions)), `ask_thread` would take
`question` (1 to 600 characters), post it with the same checks, record `asked: true` in the turn
state and return "Question posted. End your turn now; the answer arrives as your next message." `finish`
would then accept an output with no `reply` and no `ignore` when `asked` is set, instead of failing
with "no reply". That is the only harness change it needs; an agent that ends with its question as `reply`
gets the same result with one fewer concept.

### Audit and the per-call policy

- **Per-call gate.** The tool is an MCP call on server `centaur-chat`, so an operator `forbid` on
  `CallTool` for `centaur-chat` or for `post_update` refuses it, with the same caveat as the read
  tools: the hook is installed only when `mcp_servers` is non-empty. A config with only
  `chat_tools.progress` has no gate, so to disable it set `progress: false`. The same live
  confirmation as chat-context slice 6 (denial reaches the agent as a tool error under
  `claude-code-action`) covers both.
- **Audit.** The post-run `audit-tool-calls` step re-evaluates the agent's MCP calls against the
  same policy, so a `post_update` call a policy would have refused fails the turn like any other.
  The server also logs, to stderr and the job log, only a count (`centaur-chat: post_update #n`), never
  the text or thread ID. The poster logs the bot, chat ID and result, never the text. Message
  content stays out of GitHub, as chat-context requires.
- **Cedar attributes.** `post_update`'s argument is free text; policy can match its tool name, not
  its meaning. Per-turn and per-thread caps carry the rest.

### Slack and Telegram

- **Slack.** The post goes into the thread (`slack:<channel>:<ts>`) via the adapter, like the
  reply. Markup in the text is mrkdwn: the reply already goes through the same `thread.post(text)`, so
  `*bold*` and links behave identically. Mention neutralization (above) is the Slack-specific part.
- **Telegram.** The post goes into the topic (`telegram:<chat>:<topic>`); in a chat without topics it
  is a plain message in the chat, as replies already are. A closed or deleted topic fails the post
  with the adapter's error; an update is never worth reopening a topic for, so the poster returns
  the error, the tool says `Not posted: the thread is unavailable` and the turn carries on
  (`start-thread`'s reopen/new-topic fallback is deliberately not applied).
- **Differences that matter.** Telegram has no edit history shown to the agent and no `ts`
  ordering guarantee beyond message IDs; neither affects a fire-and-forget post. Rate limits differ
  (Telegram: about one message per second per chat, 20 per minute per group); the 15 second spacing
  stays far below both.

### Prompt guidance

A short block, `src/workflows/instructions/mid_turn.md` (overridable as `instructions.mid_turn`),
included in chat turns only when `progress` is on, in the same place as `chat_tools.md`:

```
You can post short progress messages to this thread with the post_update tool. Use it only
before a step that will take minutes (a long build or test run, a large search) or when your plan
changes in a way the person would want to know. Write one or two plain sentences; do not quote
files, tool output, secrets or environment values; do not mention people. You may post at most
{max_updates} updates in a turn, and your final reply is separate: do not repeat an update in it,
and do not use updates for results.
If you need an answer from the person before you can continue, do not wait: end the turn with a
reply that asks one clear question, says what you already found and what you will do with each
answer. Ask before you edit files when the answer would change the edit. The answer arrives as your
next message.
```

`{max_updates}` is the only substitution, filled by `prepare`; the block's content is not parsed, so
it is not code-parsed text under `AGENTS.md`'s rule. A `centaur-chat-tools` skill paragraph repeats
the question guidance when skills are installed.

### Turn failure and timeout

Updates already posted stay: they are ordinary messages and nothing deletes them. When the turn
fails or times out (`notify-failure`, `notify-timeout`) the generic failure notice is posted after
them, so the thread reads "update, update, failure notice", which is the useful signal (the person
sees how far it got). The marker is not advanced, so the next message retries the same messages, and
the retried turn can post updates again. The retried agent sees the earlier updates in the thread
transcript (the poster stored them), and the guidance says not to repeat itself, which is
best-effort; duplicates are possible and accepted. A turn that hit `max_budget_usd` ends with the
spending-limit notice as before. No cleanup, edit or deletion of updates is attempted: Telegram
bots cannot delete messages older than 48 hours reliably and Slack deletion needs more scopes, for
little gain.

An update posted by a run that is later cancelled (a newer message superseded it) is just a stale
message; the next turn's transcript includes it.

## Decisions

Recommendations in bold; each needs the maintainer's approval before building.

1. **Where it lives.** **Extend `centaur-chat`** with a registered-tools-per-flag model, vs a new
   `centaur-thread` server. The extension reuses the client, OIDC file and gate; the cost is that
   `scope` and `progress` must be read independently in `prepare`.
2. **Config key.** **`chat_tools.progress` (default off) and `chat_tools.max_updates`**, independent
   of `scope`. The alternative, requiring `scope: chat`, ties a harmless write-to-own-thread to a
   cross-thread read capability.
3. **One tool or two.** **Only `post_update`; questions end the turn with a `reply`.** An `ask_thread`
   tool buys nothing a final reply does not, and it needs a `finish` change (accept no reply) and a
   guidance rule about not calling it twice. Revisit if agents are seen to bury questions in long
   replies.
4. **Answer path.** **A normal next turn (the resumed session on `resume` threads); no suspend.**
   `suspend_for` is for events with no message to dispatch on.
5. **New poster operation.** **`post-update`, token required, dispatched thread only, thread must
   belong to the bot**, not a looser `post`. The poster cannot verify that the thread is the one the
   run was dispatched on (the token carries only the repository); that trust sits with the server
   (no thread parameter) and the bound repo, as for `search-chat`.
6. **Redaction.** **No scrubber; rely on the 600 character cap, the guidance and the structural
   rule that the tool takes only agent-written text.** An optional pattern pass over well-known
   token shapes (GitHub, AWS, Slack) in the poster could be added later, but a second hand-rolled
   scrubber that the final reply does not share would give false assurance; if one is wanted, do it
   as a library for both paths in a separate item.
7. **Limits.** **5 updates per turn (configurable to 20), 600 characters, 15 second spacing, 20
   per thread per hour in the poster.** Tune after live use.
8. **Mentions.** **Neutralize rather than reject**, in the poster, for both platforms, so a
   compromised or confused server cannot ping anyone.
9. **Failure behavior.** **Leave posted updates; accept duplicates on retry.**
10. **Scheduled and `/new` turns.** **Not available** (no dispatched thread). A scheduled run that
    wants to report progress would need a target; out of scope.
11. **Unavailable thread (Telegram deleted or closed topic).** **Return an error, do not reopen or
    create a topic.**

## Failure modes

| Failure | Behavior |
|---|---|
| Poster call fails (network, Lambda error) | Tool returns `Not posted: <SafeError first line>`; the turn continues; stderr gets `centaur-chat: post_update failed: <detail>` like the read tools. |
| OIDC credentials file missing | `Not posted: OIDC credentials unavailable`, as for the read tools. |
| Per-turn cap reached | `Not posted: update limit reached`, no poster call. |
| Thread-hourly cap reached | Poster error; tool says `Not posted: too many updates in this thread`. |
| Chat not approved or blocked, thread unknown to the bot, bot unbound | Poster rejects with a descriptive error; the tool reports `Not posted` with the first line. The turn is not failed: an update is best effort. |
| Lambda predates the operation | The strict schema rejects it as an unknown operation; deploy the Lambda before enabling `progress` (as for `visibleOnly`). |
| Agent posts the same text repeatedly | Spacing and the per-turn cap stop it; nothing deduplicates. |
| Agent pastes a secret | See Decision 6; the same exposure as `reply`. |
| Update posted, turn then fails | Update stays, then the failure notice. |
| Prompt injection from a message tells the agent to spam or leak via updates | Bounded by count, length, rate, mention stripping and the thread's own audience; the update goes to the same thread the injection came from, so it widens no audience. |

## Plan

| Slice | What | Files (expected) |
|---|---|---|
| 1 | Config: `chat_tools.progress`, `max_updates`; schema, defaults, `docs/config.md`, fixtures, config tests | `src/config/`, `docs/config.md`, `test/config.test.ts` |
| 2 | Poster `post-update`: schema, caller and chat checks, thread-belongs-to-bot check, text normalization and mention neutralization, hourly counter, `postInThread`; `docs/poster.md` | `src/lambda/post-update.ts`, `src/lambda/poster.ts`, `docs/poster.md` |
| 3 | MCP: `post_update` tool, per-turn cap and spacing, client method, entry wiring, per-flag tool registration | `src/mcp/chat-server.ts`, `src/mcp/chat-poster-client.ts`, `src/mcp/poster-chat-client.ts` |
| 4 | `prepare`: start the server for either flag, exact `--allowedTools` entries, guidance block, `centaur-chat-tools` skill text | `src/workflows/prepare.ts`, `src/workflows/mcp-config.ts`, `src/workflows/instructions/mid_turn.md`, `skills/` |
| 5 | Docs: update `chat-context.md` (config, tool gate), `workflows.md` (turn lifecycle, failure notice), `mcp.md` pointer | docs |
| 6 | Live check (**[HUMAN ACTION]**): a long turn posts an update on Slack and on Telegram; the deleted-topic error; `CallTool` forbid reaches the agent | none |

Slices 1 to 3 are independent of each other except 3 needing the shape of 2. Deploy order: Lambda
(slice 2), then the runner action.

## Verification

All without live calls:

- **Config:** the new keys parse, default off, reject a non-integer or out-of-range `max_updates`.
- **Poster (fake adapters in `test/helpers/`):** posts to the dispatched thread's chat; rejects an
  unbound bot, a wrong repository, an unapproved or blocked chat, a thread the bot has no record
  of, and an over-long text; neutralizes Slack and Telegram mentions (a table of inputs); the hourly
  counter trips at the cap and expires; the post lands in the stored transcript and, on Telegram, the
  chat list; a Telegram "thread not found" error is returned, not recovered.
- **Receiver:** a bot's own update posted into a thread does not dispatch a turn, for `bot_messages`
  both `ignore` and `mention`.
- **MCP server (in-memory transport, fake client):** `post_update` is registered only with the flag;
  the server has no thread parameter; the sixth call and a call inside 15 seconds return `Not posted`
  with no client call; a client failure is reported with only the safe detail and never the text; the
  stdout carries only protocol.
- **Entry:** the spawned-process test with a fake `aws` and token endpoint, as for the read tools.
- **`prepare`:** `mcp.json` and `--allowedTools` for each combination of `scope` and `progress`; no
  server on scheduled and `/new` turns; a configured `centaur-chat` still fails the turn; the
  guidance block appears only with the flag.
- **Gate:** a `forbid` on `CallTool` for the tool refuses it (the unit test used for the read tools),
  and the audit flags a call a policy would have refused.
- `yarn lint`, `yarn typecheck`, `yarn test`, `yarn lint:cfn`, `yarn bundle:lambda` (the MCP code
  stays out of the Lambda bundle, as AGENTS.md requires).
