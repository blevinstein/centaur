# Poster operations

The poster is the same Lambda function as the receiver, entered by direct invocation
(`aws lambda invoke`, authorized by IAM through the GitHub OIDC role). The function URL stays
public for webhooks; the handler treats any event with an `operation` key as a poster request and
everything else as a webhook. See [plan.md](plan.md#poster-lambda) for where it fits.

Requests are JSON objects validated strictly (unknown keys are errors). A failure surfaces as a
Lambda `FunctionError` whose payload carries the message. Bots must be fully configured and bound
to a repo (a connection's secrets under `bots/<bot>/platforms/<platform>/` plus `bots/<bot>/repo`) for every operation except `register`.

| `operation` | Fields | Result |
|---|---|---|
| `post` | optional `token` (GitHub OIDC JWT), `bot`, `threadId`, `text` | `{ messageId }` |
| `start-thread` | optional `token` (GitHub OIDC JWT), `bot`, `text`, optional `title`, optional `context` (`fresh`, `transcript` or `resume`: the policy stored on the new thread), exactly one of `destination` (a destination name, with `platform`: required when the bot has several connections, and optional `thread`: `new` (default) or `persistent`) or `fromThreadId` (implies the platform; `platform` and `thread` are rejected with it) | `{ threadId }` |
| `resolve-destination` | `token` (GitHub OIDC JWT), `bot`, `name`, optional `platform` (as for `start-thread`), optional `thread` | `{ chatId }`, plus `threadId` when `thread` is `persistent` and the destination has a bound thread, or `{ found: false }` when the name holds nothing; creates nothing |
| `read` | `token` (GitHub OIDC JWT), `bot`, `threadId`, optional `visibleOnly` | `{ messages: [{ id, userId, userName, fromBot, text, attachments, sentAt }], policy? }`, oldest first; `policy` is the context policy stored on the thread by `start-thread`, absent when none is stored (reading refreshes its expiry); `attachments` are the S3 keys of the message's stored images (see [Attachments](#attachments)); with `visibleOnly: true` the poster drops messages from senders who are not enrolled and from other bots, the same filter as `list-threads` and `read-channel`, and the thread's chat must be approved and not blocked. Without it every stored message is returned, as `prepare` needs for the dispatched thread |
| `unreact` | optional `token` (GitHub OIDC JWT), `bot`, `threadId`, `messageIds` (1 to 50) | `{ results: [{ messageId, removed }] }` |
| `list-threads` | `token` (GitHub OIDC JWT), `bot`, `chatId`, `threadId` (the dispatched thread), optional `limit` (default 20, max 50), optional `includeBots` | `{ threads: [{ threadId, title, lastActivity, messageCount, participants, snippet }], scanned }`, most recent first |
| `read-channel` | `token` (GitHub OIDC JWT), `bot`, `chatId`, `threadId` (the dispatched thread), optional `limit` (default 50, max 200), optional `before` (ISO 8601 instant), optional `includeBots` | `{ messages: [{ id, threadId, userId, userName, fromBot, text, attachments, sentAt }], scanned }`, newest first; `attachments` is always empty |
| `get-mcp-policy` | optional `token` (GitHub OIDC JWT) | `{ policy }`: the text of the global MCP policy bundled with the Lambda (`mcp-policy.cedar` next to the handler), or `null` when none is deployed |
| `register` | `token` (GitHub OIDC JWT), `config` (the config file's text) | `{ bot, repo }` |
| `link-pull-request` | `token` (GitHub OIDC JWT), `bot`, `threadId`, `pullRequest` (number) | `{ linked: true }` |
| `resolve-pull-request` | `token` (GitHub OIDC JWT), `pullRequest` (number), optional `withThreadId` (boolean) | `{ found: false }` or `{ found: true, bot, threadKey }`, plus `threadId` only when `withThreadId` is true |
| `mcp-approvals` | `token` (GitHub OIDC JWT), `bot`, optional `threadId` and `messageId` (together), `servers`: `[{ name, fingerprint, summary }]` (1 to 20; `summary` at most 2000 characters), optional `suspend` (boolean) | `{ servers: { <name>: "approved" \| "pending" \| "denied" } }` |

All thread operations go through the bot's own Chat instance and state prefix (`bot:<bot>:`), so
the bot's posts land in the stored transcript the receiver and `read` use.

## Choosing the connection

A bot has one connection per platform it declares. Operations that take a `threadId` (`post`,
`read`, `unreact`, `list-threads`, `read-channel`) use the connection of the thread ID's platform
prefix, so one bot serves its Telegram and Slack threads each with that connection's token and
adapter. A bot with no connection on that platform fails with `bot "<bot>" has no connection on
platform "<platform>"`, and an ID with no known platform prefix is rejected.

`start-thread` with `fromThreadId` uses the connection of that thread's platform. With
`destination` it takes `platform` (`telegram` or `slack`); the field is optional when the bot has
exactly one connection and required otherwise (`bot "<bot>" has several connections (...);
platform is required`). `platform` together with `fromThreadId` is rejected. `link-pull-request` and
`resolve-pull-request` store and read records only and open no connection.

## `start-thread`

The destination chat comes from the request, so the poster never needs prompt names. Scheduled
runs pass `destination`, the prompt's destination name from the config, which the poster looks up
once at `/centaur/chats/<platform>/<destination>` on the connection's platform (see
[Destinations](#destinations)). The chat it holds must be approved for that connection and not
blocked. Names are scoped to a platform, so one name can mean a Telegram group and a Slack channel;
the flat `/centaur/chats/<name>` is not read, and a name that exists only on another platform is
unknown. An unapproved or blocked chat fails the request with an error that names the bot, the
platform and the name and, for an unapproved chat, the `centaur access approve <bot> chat <id>`
command that fixes it. `/new` passes `fromThreadId`, the thread the command came from, and the new
thread starts in that thread's chat, which must be an approved chat or a DM.

- **Telegram:** `createForumTopic` in the destination supergroup (the bot needs the Manage Topics
  admin right), named `title` or the first line of `text` (at most 128 characters), then `text` is
  posted into the topic. Thread ID is `telegram:<chatId>:<topicId>`.
- **Slack:** `text` is posted as a new top-level message in the destination channel; `title` is
  ignored. Thread ID is the new message's thread.

The thread is marked `createdByBot` (`BOT_CREATED_STATE` in `src/lambda/ownership.ts`) so the
receiver's ownership rule accepts human replies in it. It also gets a `thread-meta:<threadId>`
record in the bot's state (`src/lambda/thread-meta.ts`) holding the optional `context`, who set it
(`start-thread`) and when. The record expires after 90 days, refreshed whenever it is read (by
`read` and by the ownership rule), and the ownership rule accepts a reply in any thread that still
has one, which outlives the 30-day thread state. A request without `context` still writes the
record, with no policy.

## Destinations

A destination is the one store `chats/<platform>/<name>`, per platform. Its value is either a bare
chat ID (a destination with no thread, which approvals and the CLI wrote before records) or a JSON
record:

| Field | Meaning |
|---|---|
| `chatId` | The chat or channel ID, in the platform's own form. |
| `threadId` | Optional. The persistent thread (`telegram:<chat>:<topic>` or `slack:<channel>:<ts>`), bound by a `persistent` run. |
| `bot` | Set with `threadId`: the bot that owns the thread. Another bot resolving the name fails with `destination "<name>" on <platform> is bound to a thread owned by bot "<owner>", not "<bot>"`. |
| `context` | The context policy of the prompt that last posted into `threadId`, mirrored from `thread-meta`. |
| `name`, `at` | Display name and time of the last change. |

New writes (approvals, create on first use, binding) always store the record; both shapes are read.

**Resolution.** One lookup of the name. A record or bare ID is used as it is, after the approved and
not-blocked check. A name with no value is created on first use: if the connection has exactly one
approved chat, the poster writes a thread-less destination for it with a conditional create, so two
concurrent runs create one. With no approved chat, or several, it fails and names `centaur destination
set <bot> <name> --platform <platform> --chat <id>`. `resolve-destination` never creates.

**`thread`.** `new` (the default, and what a request without `thread` means) always opens a fresh
thread in the destination's chat and never reuses or changes a bound thread. `persistent`:

- posts into the record's `threadId`; with none, it opens a thread in the record's chat, binds the
  thread, the owning bot and the request's `context` to the record, and posts into it. A run holds
  a state lock on the name while it does this, so concurrent runs share one thread.
- writes `thread-meta` for the thread with `destination` set, so the record never expires, and
  rewrites the stored policy and the record's `context` on every run.
- **Telegram.** On a bound topic, a "thread not found" error from Telegram (a deleted
  topic) opens a new topic and overwrites the record; a "topic closed" error first calls
  `reopenForumTopic` and falls back to a new topic when that fails. The new topic starts with no
  transcript. A chat that is not a forum fails with `destination "<name>" is a chat without forum
  topics, so it cannot hold a thread`, and binds nothing. Any other posting error is returned and
  leaves the record alone. A live check on 2026-11-24 confirmed `Bad Request: message thread not
  found` for a post into a deleted topic and `Bad Request: the chat is not a forum` for
  `createForumTopic` in a non-forum chat. A bot with the Manage Topics right can still post into a
  closed topic, so nothing reopens one in that setup; the `TOPIC_CLOSED` text is unconfirmed for a
  bot without topic rights. `reopenForumTopic` on a deleted topic fails with `TOPIC_ID_INVALID`.
- **Slack.** With no bound thread, the poster posts the message as a top-level post in the
  record's channel; that post's `ts` is the thread (`slack:<channel>:<ts>`, built by the adapter),
  which is bound to the record. Later runs reply into it. A `message_not_found` or
  `thread_not_found` error from Slack (the thread is gone) opens a new top-level post and overwrites
  the record; the new thread starts with no transcript. Slack has no closed threads. An
  `is_archived`, `channel_not_found` or `not_in_channel` error fails with `destination "<name>" is in
  a channel that is archived or not accessible to the bot`, binds nothing and keeps the record. Any
  other posting error is returned and leaves the record alone. A DM channel works like any other
  channel. `new` opens a fresh top-level post per run, as before. The same live check confirmed
  `channel_not_found` for a nonexistent channel and `not_in_channel` for a public channel the bot
  has not joined, archived or not. Slack accepts a reply whose parent message was deleted (or never
  existed) without an error, so the replies continue under Slack's "message deleted" stub and the
  recreate path above does not trigger; only a Telegram deleted topic recreates. `is_archived` is
  unconfirmed, since it needs a bot that is a member of an archived channel.

The runner sends `thread` on `start-thread` only for a `thread: persistent` prompt, and calls
`resolve-destination` (with `thread: persistent`) before the agent runs to find the bound thread, so
this Lambda must be deployed before a config uses `thread: persistent`.

## `unreact`

Removes the bot's 👀 reaction (the one the receiver adds when it accepts a message) from each listed
message, through the adapter's `removeReaction`. A failure on one message is logged with the bot,
thread and message ID (never message content) and reported as `removed: false`; the remaining
messages are still processed, so the call only throws for an invalid request or an unknown bot.

- **Slack:** removes only the `eyes` reaction. A message that has no such reaction reports
  `removed: false`.
- **Telegram:** `setMessageReaction` replaces the bot's own reaction list, and the Chat SDK adapter
  clears it with an empty list, ignoring the emoji. That drops any other reaction the bot set on
  the message, but never other users' reactions; the bot's other reactions are the MCP approval states ([mcp-approval.md](mcp-approval.md#suspend-and-resume)). Removal is idempotent.
- Reactions on Telegram business-account threads are unsupported and report `removed: false`.

## `list-threads` and `read-channel`

Read-only views of the chat the turn was dispatched in, for the agent's chat tools (see
[chat-context.md](chat-context.md)). They take the repository from the verified OIDC claim and
require `bots/<bot>/repo` to equal it, like the pull request operations. The poster, never the
caller, enforces:

- `chatId` is approved for the bot and not blocked (the check `start-thread` uses). DMs have no
  approval, so they are refused.
- `chatId` is the chat of `threadId`, the thread the turn was dispatched for. The poster derives the
  chat from that thread ID, so a caller can read only the chat it was dispatched in. Any other
  approved chat is refused.
- Messages from senders who are not enrolled for the bot are dropped. The bot's own messages stay.
  Other bots' messages are dropped unless the request sets `includeBots`.
- Caps: `limit` above the maximum is rejected; message text is clipped to 4000 characters, titles to
  100, snippets to 200, and a thread lists at most 10 participants.

Failures log the operation, bot, chat ID, requested limit and error type, never message content.

**`scanned`** is `{ oldest: string | null, exhausted: boolean }`: `oldest` is the send time of the
oldest message examined (`null` when none was; messages from senders who are not enrolled count as
examined), and `exhausted` is `true` when nothing older was left to examine, because the stored list
or the one Slack page was the whole source. It is `false` when the read stopped at `limit` or Slack
reported an older page. When `exhausted` is `false`, a short result means only that nothing in the
examined range qualified; older messages can be read with `before`.

- **Telegram:** the Bot API has no history call, so both operations read the messages the receiver
  stored for the chat (including messages from senders who are not enrolled, which are filtered
  out here). The SDK keeps one list per thread and one per chat (`msg-history:<id>`), each capped at
  the newest `HistoryMaxMessages` messages with a `HistoryTtlDays` TTL refreshed on every append, so
  a list expires after that many days without a message. The stack parameters default to 100 and 7
  (the SDK's own defaults), are bounded to 5000 and 365, and reach the Lambda as
  `HISTORY_MAX_MESSAGES` and `HISTORY_TTL_DAYS` (`src/lambda/history-window.ts`; invalid values fail
  the cold start). The window is stack-wide, not per bot. The state adapter reads a whole list on
  every append to trim it, so the cost per stored message grows with the window; see
  [chat-context.md](chat-context.md#what-the-platforms-can-provide). The reader scans the whole
  chat list, which the window bounds. `list-threads` groups the chat list's messages by topic, so it sees only topics
  with a message among the chat's newest `HistoryMaxMessages`, and `read-channel` cannot page beyond them. `title`
  is the first line of the oldest message seen, `snippet` the newest, `messageCount` and
  `participants` count visible messages only. `before` skips messages sent at or after it. The
  poster records each message it posts (`post`, `start-thread`) in the chat's list as well
  (`src/lambda/channel-history.ts`), so the bot's own posts and threads only it has written in are
  listed. Posts made before that was added exist only in their thread's list, so older bot posts
  are missing here until the window passes. The reader calls `chat.history.thread.collect` with the
  chat's channel ID, which falls back to the stored list; `chat.channel(id).messages` does not.
- **Slack:** `list-threads` maps the adapter's `listThreads` (thread parents with replies; the title
  and snippet are the parent's text, `messageCount` is replies plus one, `participants` only the
  parent's author). `read-channel` maps `fetchChannelMessages` (top-level messages only); `before`
  becomes the `conversations.history` `latest` cursor. Filtering happens after the fetch, so a page
  can hold fewer than `limit` messages.

## `register`

The workflow sends the JWT from the GitHub Actions OIDC endpoint, requested with the audience
configured below. The Lambda verifies the signature against GitHub's JWKS, the issuer, the
audience and expiry, and requires `repository_owner` (and the owner half of `repository`) to equal
the configured owner. The repo name comes only from the verified `repository` claim.

Then it parses `config` with `parseCentaurConfig` and, in order:

1. requires, for each platform in the config's `platforms`, that connection's `token` and
   webhook/signing secret in SSM, and fails naming the bot and platform otherwise, before any write.
   A connection in SSM that the config does not declare is left untouched and is not served;
2. refuses if `bots/<bot>/repo` holds a different repo (`centaur bot unbind` first);
3. writes `bots/<bot>/repo`, then the registry entry `registry:<bot>` =
   `{ platforms: { <platform>: { respond_to, handle? } } }`, one item per declared platform. The
   receiver serves a connection only while this entry lists its platform; an entry in the old shape
   (`{ respond_to }`), or none, serves nothing until `register` rewrites it, with one log line naming
   the bot;
4. for each Telegram connection, calls `setWebhook` with `<function URL>/telegram/<bot>` and the
   stored webhook secret. Slack needs no call.

Re-registering from the owning repo is idempotent. Binding is check-then-write, so two repos
registering a fresh bot at the same instant could race; the maintainer's secret creation is the
gate, which makes this a low risk.

## `link-pull-request` and `resolve-pull-request`

These map a pull request to the chat thread it belongs to, for the pull request comment turns in
[pr-comments.md](pr-comments.md). The repository is never part of the request: both operations take
it from the verified OIDC `repository` claim, as `register` does, and a request that names a
repository is rejected as an unknown key.

`link-pull-request` requires `bots/<bot>/repo` to equal the caller's repository, then writes
`pull-request:<repository>#<number>` = `{ bot, threadId }` in the state table (under the empty
registry prefix) with a 90-day TTL (`PULL_REQUEST_TTL_MS`). Linking again overwrites the record and
restarts the TTL. An unknown, unbound or differently bound bot fails the request.

`resolve-pull-request` reads the record for the caller's repository and number. It returns
`{ found: false }` when there is no record, the record has expired, or the bot is no longer bound
to the caller's repository; none of these is an error, so callers skip silently. A hit restarts the
TTL, so a pull request with activity never expires, and returns the bot and the 12-hex thread key
(`threadKey` in `src/thread-key.ts`). The raw `threadId` is returned only when the request sets
`withThreadId: true`. It is the sensitive part (a chat ID): a caller that asks for it must mask it
(`::add-mask::`) before anything else and never write it to a job output, step output, log, or any
GitHub-visible place. The thread key is what outputs and concurrency groups use.

After a comment turn, `finish` calls `link-pull-request` again for the same pull request and
thread, which restarts the TTL.

## `mcp-approvals`

Reads the admin's decision for each MCP server definition, identified by `<name>:<fingerprint>` (`summary` is shown to the admin and only length-limited). The repository comes from the verified OIDC claim and must be the bot's bound repository. For each server, in order:

1. The SSM record `bots/<bot>/mcp-approvals/<name>/<fingerprint>` exists: `approved`.
2. The `denied:mcp:<name>:<fingerprint>` state record exists (7 days): `denied`.
3. Otherwise the shared request raiser opens one request to the platform admin (one pending request per definition, 10 new requests per bot per hour, 7-day expiry) and the result is `pending`. A request over the hourly limit or one that could not be delivered is also `pending`.
4. A bot with no admin on its platform gets `denied`, no record is created, and the Lambda logs a warning with the bot and platform.

Reads are idempotent: a repeated read neither creates a second request nor sends a second DM. Without `threadId` and `messageId` (both or neither; `suspend` requires them) the operation is read-only and needs no platform, so it works for a bot on several connections: it answers `approved` or `denied` from the stored records and `pending` otherwise, and never creates a request, sends a DM or touches a pending request. A scheduled prompt without a thread uses an approved server but cannot request one. `suspend: true` marks the pending request `suspended` and records `threadId` and `messageId` on it, so the decision re-dispatches that thread; a read without `suspend` never sets or clears the flag. A suspending call also leaves the waiting reaction on the triggering message (the decided reaction when the request was decided meanwhile), best-effort. A `suspend` call that finds a server already decided, or whose request is decided while it is marked, resumes the thread with the same dispatch as the decision handler, once per call. An error reading SSM or state fails the invocation; the client treats a failed call as `pending`, never `approved`.

## Security model

Every operation that acts for a bot checks the caller. `read`, `resolve-destination`,
`list-threads`, `read-channel`, `link-pull-request`, `resolve-pull-request`, `mcp-approvals` and
`register` always take a `token` (see [`register`](#register) for how it is verified) and take the
repository from the verified claim. `read`, `resolve-destination`, `list-threads`, `read-channel`,
`link-pull-request` and `mcp-approvals` also require the bot to be bound to that repository, so a
repo cannot act on another repo's bot.

`post`, `unreact` and `start-thread` take the same check through an optional `token`
(`src/lambda/caller-check.ts`): the token is verified and `bots/<bot>/repo` must equal its
repository, so the bot is rejected when unbound or bound elsewhere. `get-mcp-policy` names no bot, so
its token is only verified (signature, issuer, audience, expiry, owner). The workflow client
(`createPosterClient`) mints the job's token and attaches it to these four operations; when the job
has no OIDC grant it sends none.

`REQUIRE_POSTER_TOKEN` (stack parameter `RequirePosterToken`, default `false`) controls a request
that has no token:

- `false`: the request is accepted, as it was before the check existed, so a repo still on an older
  workflow version keeps working. A token that is present is always verified, so a wrong one is
  rejected even here.
- `true`: the request is rejected. Any other value fails the Lambda's cold start rather than
  relaxing the check.

Roll out in order: deploy the Lambda (default `false`), update every bound repo to a workflow
version that sends the token, then set `RequirePosterToken` to `true`. Until it is `true`, any
repo under the owner can still act as any bot by sending no token, so the isolation holds only after
the switch. The OIDC role's trust policy is limited to `repo:<owner>/*`, so callers outside the
owner never reach the Lambda.

`GITHUB_OWNER` may be the owner's login or its numeric id; an id is compared with the token's
`repository_owner_id`, which a rename does not change.

A hosted multi-tenant deployment additionally needs a reserved-concurrency cap on the function so
one tenant cannot exhaust it ([hosted.md](proposals/hosted.md)).

## Lambda configuration

Environment variables (set by `infra/centaur.yml`; see [deploy.md](deploy.md)):

| Variable | Used by | Meaning |
|---|---|---|
| `STATE_TABLE_NAME` | both | DynamoDB state table. |
| `GITHUB_OWNER` | poster | Allowed repository owner (login or numeric id); same value as the template's `GitHubOwner`. |
| `OIDC_AUDIENCE` | poster | Audience the workflow requests for its OIDC token (`audience=` on the token request); a fixed string agreed with the workflows. |
| `REQUIRE_POSTER_TOKEN` | poster | `true` rejects `post`, `unreact`, `start-thread` and `get-mcp-policy` requests that carry no token; `false` or unset accepts them (see [Security model](#security-model)). Any other value fails startup. |

The public function URL, used to build webhook URLs, is read from the SSM parameter
`/centaur/function-url` that the template writes (an environment variable can't reference the
function's own URL).

## Attachments

When an enrolled sender's message carries images (JPEG, PNG, GIF or WebP; a Telegram photo or an
image sent as a file), the receiver downloads them from the platform once and stores them in the
session bucket at `attachments/<bot>/<thread>/<message>~<n>.<ext>` before it reacts and
dispatches (`src/lambda/attachments.ts`). If storing fails (including an image over 20 MB) the
receiver tells the sender and dispatches nothing. Other attachment types are ignored. `read` lists
the keys that exist for each message by listing the thread's prefix. An image in a message that has
no stored copy yet (sent before attachment storage existed, or whose upload failed) is stored by
`read` itself, rebuilding its downloader from the file ID kept in the thread history; the key is
deterministic, so a message that is already stored keeps its existing object and is never fetched
again. A failure there is logged and the message is returned without attachments. The workflow
copies the keys with its own AWS credentials, so no URLs are signed and the agent needs no network
tool. The Lambda role
has `s3:PutObject` and `s3:ListBucket` on `attachments/*` only, and objects expire after
`AttachmentExpirationDays`.

IAM for the function role: everything the receiver has. `register` writes only
`/centaur/bots/*/repo`; the receiver's access-request decisions write the approved and blocked paths
and create destinations under `/centaur/chats/<platform>/*` (without overwriting; binding a thread rewrites the record)
(see [deploy.md](deploy.md#iam)). `start-thread` resolves access with the same resolver as the
receiver (admin, approved and blocked chats). It needs
`ssm:GetParametersByPath` on `/centaur/bots` and `/centaur/chats`, `ssm:GetParameter` on
`/centaur/chats/*`, KMS decrypt, and read/write on the state table.

For callers, the GitHub OIDC role needs `lambda:InvokeFunction` on the function (not the function
URL). The workflow assumes that role for AWS access and separately requests the audience-scoped
JWT to pass as `token`.

## Design notes

- **One function, two entry points.** A single cold-start path for SSM and state; the function URL
  can't be IAM-authenticated without also locking out Telegram and Slack, so the poster is
  reachable only through `lambda:InvokeFunction`.
- **The Lambda and the CLI have separate SSM store interfaces.** The CLI needs SecureString
  writes, listing and deletion, while the Lambda only needs plain-`String` writes and deletion of
  admin claims; merging the interfaces would force each side to implement operations it never uses.
