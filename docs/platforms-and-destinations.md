# Bots across platforms and topic destinations (design)

> **Status: built and live (2026-11-24).** One bot serves several platforms, each with its own
> connection, and prompts post to named destinations that can hold a persistent thread. Built: slices
> 1 to 12, 14 to 17 and 21, and the cutover (slice 18, executed 2026-11-23). Dropped: slice 13, the
> in-chat binding commands ([Decision 20](#decisions)); `centaur destination set` binds an existing
> topic instead. Open: the live checks of slice 19. The migration tooling was removed (slice 20). The text below is the design as it was accepted, and the [Decisions](#decisions) remain the
> record of why. The reference pages ([plan.md](plan.md), [config.md](config.md), [cli.md](cli.md),
> [poster.md](poster.md), [workflows.md](workflows.md)) describe the behavior as built. Terms
> (receiver, poster, turn, state table) are defined there.

Two items from [TODO.md](../TODO.md) are designed together because they change the same records:
one bot present on several platforms, and named destinations that can point at a topic or thread
inside a chat.

## Problem and goals

A bot is one SSM record with a single `platform`, one set of secrets and one repo, so the same bot
cannot be on Telegram and Slack. Each platform needs its own bot name (`garden`, `garden-slack`),
and `centaur bot add` refuses a name that exists. A prompt's `destination` named only a chat, so a
recurring prompt opens a new topic or message on every run instead of keeping one persistent thread,
and a scheduled prompt's context policy applies only to its first turn: replies in the thread fall
back to `context.default` because the policy is not stored.

Goals:

1. One bot with several platform connections (each with its own secrets, webhook route, approved
   chats and users, and destinations), one repo binding, one config and one persona.
2. A repo declares its connections, per-platform settings (`respond_to`, `handle`) and prompts whose
   destinations resolve per platform, for example the same weekly plan in a Telegram topic and a
   Slack channel.
3. Named destinations that hold a chat and an optional topic or thread, so a recurring prompt keeps
   one persistent thread; the thread keeps the prompt's context policy for replies.
4. Existing bots and configs are migrated once to the new model, with a backup and a short planned
   outage; the old layout and keys are not read afterwards.

Non-goals: two connections to the same platform for one bot (two Slack workspaces), one agent turn
that spans threads of different platforms as one conversation, and any change to who may talk to the
bot (access stays admin-approved, per connection).

## What assumed one platform per bot

| Where | Assumption |
|---|---|
| `.centaur.yml` (`src/config/schema.ts`) | `bot` plus one top-level `platform`, `respond_to` and `handle`; prompt `destination` is one chat name. |
| SSM (`src/lambda/registry.ts`, `src/cli/registry.ts`) | `bots/<bot>/platform`, `token`, `webhook-secret` or `signing-secret`; `Bot` has one `platform`. `centaur bot add` refuses an existing name. |
| Access (`src/lambda/access.ts`, `access-entries.ts`) | `bots/<bot>/approved-chats/<id>`, `approved-users/<id>`, `blocked/...` have no platform; the admin is looked up by `bot.platform`. |
| Receiver (`src/lambda/receiver.ts`, `chat.ts`) | One `Chat` per bot with one adapter, `chat.webhooks[bot.platform]`, one route `/<platform>/<bot>`, `ADMIN_CHANNELS[bot.platform]`. |
| Message handling (`message-handler.ts`, `access-requests.ts`, `admin-claims.ts`, `ownership.ts`) | `bot.platform` slices chat IDs from `channelId`, picks the admin, and decides thread-scoped ownership. |
| Registry entry | State `registry:<bot>` holds one `{respond_to}`. |
| `register` (`src/lambda/register.ts`) | Requires `secrets.platform === config.platform`; sets one webhook for Telegram. |
| Poster (`src/lambda/poster.ts`) | `loadBot(name)` returns one platform; `THREAD_OPENERS[bot.platform]`; `start-thread` takes a chat name. |
| CLI | `bot add --platform`, `access`/`admin claim` resolve the bot's single platform (`requireBotPlatform`). |
| Docs | `plan.md` (Receiver, Configuration, Access requests, SSM layout), `config.md`, `cli.md`, `poster.md`, `onboarding.md`. |

Two things already work across platforms and need no change: thread IDs are prefixed by the adapter
(`telegram:<chat>:<topic>`, `slack:<channel>:<ts>`), and the admin and admin claim are already
per platform (`admin/<platform>`, `admin-claim/<platform>`).

## Target data model

### Vocabulary

- **Bot**: a name, one repo binding, one config, one persona.
- **Connection**: a bot's presence on one platform: that platform's token and webhook or signing
  secret, approved and blocked chats and users, and destinations. At most one per platform per bot.
- **Destination**: a name that resolves, for one connection, to a chat and optionally a topic or
  thread.
  A destination with no topic is just a named chat ([Decision 18](#decisions)).

### SSM layout

Nested under the bot; the repo binding stays at the bot level.

| Parameter | Type | Written by |
|---|---|---|
| `bots/<bot>/repo` | String | `register`; cleared by `centaur bot unbind` (unchanged) |
| `bots/<bot>/platforms/<platform>/token` | SecureString | `centaur bot add` |
| `bots/<bot>/platforms/<platform>/webhook-secret` | SecureString | `centaur bot add` (Telegram; generated) |
| `bots/<bot>/platforms/<platform>/signing-secret` | SecureString | `centaur bot add` (Slack; supplied) |
| `bots/<bot>/platforms/<platform>/approved-chats/<chatId>`, `approved-users/<userId>` | String (JSON) | access request approval; `centaur access approve` |
| `bots/<bot>/platforms/<platform>/blocked/<chat\|user>/<id>` | String (JSON) | access request denial; `centaur access block` |
| `bots/<bot>/platforms/<platform>/destinations/<name>` | String (JSON) | superseded by Decision 18: slice 11 stores destinations at `chats/<platform>/<name>` instead |
| `chats/<platform>/<name>` | String | access request approval; `centaur access approve`; `centaur destination set`. The destination store: a bare chat ID or a JSON record (Decision 18) |
| `admin/<platform>`, `admin-claim/<platform>`, `github/token` | | unchanged |

The previous flat layout (`bots/<bot>/platform`, `token`, `webhook-secret`, `signing-secret`,
`approved-chats/...`, `approved-users/...`, `blocked/...`) is not read; it was moved to the nested paths once (see
[Migration](#migration)), and a bot with only flat parameters has no connection and is not served.

A connection is addressed by its base path `bots/<bot>/platforms/<platform>`, and every
per-connection key hangs off it. The code keeps the existing `Bot` shape as
the **connection view** (`name`, `platform`, `repo`, `token`, `webhookSecret`): `loadBots` returns one
per connection, so the access resolver, access requests, admin claims, ownership and message handler
keep taking a single-platform `Bot` and change little.

Destination record (JSON):

| Field | Meaning |
|---|---|
| `chatId` | The chat or channel ID, in the platform's own form. |
| `threadId` | Optional. The platform thread ID of the persistent thread (`telegram:<chat>:<topic>`, `slack:<channel>:<ts>`). Absent means a destination with no bound thread; the prompt's `thread` setting decides whether a run reuses a bound thread or creates and binds one ([Decision 19](#decisions)). |
| `name`, `at` | Display name and time of the last change, as in access entries. |

Destinations are platform-scoped (`chats/<platform>/<name>`), so `household` can name a Telegram group
and a Slack channel without the `-2` suffix. The flat `chats/<name>` is not read. The "chat is approved for this connection" check rejects a name that points at another
platform's chat. The Lambda role's `chats/*` wildcard already covers the nested path.

IAM: IAM `*` in a resource ARN also matches `/`, so the statements on
`bots/*/approved-chats/*`, `approved-users/*` and `blocked/*` already match the nested paths, but
the destination path needs its own `ssm:PutParameter` statement
(`bots/*/platforms/*/destinations/*`) and `test/infra.test.ts` / `yarn lint:cfn` must be rerun
(not needed from slice 11, [Decision 18](#decisions)).

### State table

| Key (prefix `bot:<bot>:`) | Content |
|---|---|
| `registry:<bot>` (empty prefix, unchanged name) | `{ platforms: { <platform>: { respond_to } } }`. An old entry `{ respond_to }` is not read: the bot counts as unregistered until `register` rewrites the entry. |
| `thread-meta:<threadId>` | `{ context?, destination? }`: the thread's stored context policy and, for a persistent destination thread, its name. TTL 90 days refreshed on read; none for destination threads. |
| Everything else (dedupe, subscriptions, `thread-state:`, access requests, transcripts) | Unchanged. |

All connections of a bot share the prefix `bot:<bot>:`. Keys are made of IDs that are already
platform-prefixed (thread, message and channel IDs) or distinct in form (Slack `U...`/`C...` against
numeric Telegram IDs), so sharing one prefix is collision-free, and it keeps `garden`'s stored
history and markers.

### Access, destinations and the admin per platform

- Approved and blocked chats and users live under the connection, so approving a Telegram chat says
  nothing about Slack. `centaur access ... <bot>` takes `--platform` when the bot has more than one
  connection.
- The admin is already global per platform. A connection reaches the admin on its own platform
  through `ADMIN_CHANNELS[platform]`; the admin is allowed in every connection of that platform and
  cannot be blocked, as today.
- `admin-claim/<platform>` already stores the bot name; the claim lands through the connection of the
  claim's platform. `centaur admin claim <bot>` needs `--platform` when the bot has several
  connections.
- Access requests, the 10-per-hour limit and the request store stay per bot, shared across its
  connections.

### Thread identity and `thread_key`

Do not change `threadKey(bot, threadId)` (`src/thread-key.ts`). A thread ID already carries the
adapter prefix, so the same bot's Telegram and Slack threads cannot collide, and the SHA-256 still
hides the raw chat, topic and channel IDs. Changing the hash input would re-key every live thread and
orphan concurrency groups, `centaur/<bot>-<key>` branches and `pull-request:` links. The same holds
for `sessions/<bot>/<thread>/` and `attachments/<bot>/<thread>/`.

A rule for new code: anything public that embeds a thread, chat, channel or topic ID uses
`threadKey`, and a destination's chat and topic IDs are as sensitive as a thread ID (they never appear
in a repo, a job log or an output).

## Config schema

```yaml
bot: garden
platforms:
  telegram:
    respond_to: all
    handle: garden_helper_bot
  slack:
    respond_to: mention
prompts:
  weekly-plan:
    destination:                        # two entries: the same run is posted to both
      telegram: weekly-plan
      slack: garden-weekly
    thread: persistent                  # one thread per destination, reused every run
    context: transcript
  frost-alert:
    destination: { telegram: household }   # one entry: one target
  hello:
    destination: { slack: garden-test }
    thread: new                         # the default: a fresh thread on every run
```

A bot that declares one platform may use a string instead: `destination: household` (with
`platforms: { telegram: ... }` above, it means `{ telegram: household }`).

- `platforms` is a map from `telegram`/`slack` to `{respond_to?, handle?}` (strict). Its keys are the
  connections the repo expects; `register` fails if one has no secrets in SSM, and the receiver
  serves a connection only while the registry entry lists it.
- Per-platform settings are the platform-bound ones: `respond_to` (default `mention`) and
  `handle`. Everything else (`context`, `provider`, `model`, tools, MCP, `pull_requests`) stays
  bot-wide.
- A prompt's `destination` is a name or a map from platform to name, and the platform is always
  explicit when the bot has several. A string is valid only when the bot declares exactly one platform
  (it names a destination on that platform); a bot with several platforms must use the map. A one-entry
  map is one target; several entries are the fan-out of slice 15. The parser enforces this, so adding
  a second platform to an existing config makes `centaur config check` point at each string
  destination that now needs a map, instead of silently posting to a new place. There is no
  prompt-level `platforms` key.
- A prompt's `thread` is `new` or `persistent` (default `new`) and applies to every target of the
  prompt. It states in the config whether each run opens a fresh thread or posts into the
  destination's one persistent thread; see [Decision 19](#decisions) and [Destinations](#destinations).
  Chat and thread IDs never appear in the config (Decision 18): the name resolves to a destination
  record in SSM.
- The same resolution rule applies per platform: a name that resolves to a destination record uses
  it; otherwise it is created on first use (one lookup from slice 11, Decision 18; see
  [Destinations](#destinations)).
- A prompt with more than one target and `context: resume` is a config error: a session belongs to
  one thread.

**No legacy keys.** The parser accepts only this schema. The old top-level `platform`, `respond_to`
and `handle` are rejected with an error that names the replacement
(`platforms: { <platform>: { respond_to, handle } }`). Every consumer repo (`garden`, `centaur-hello`, the self-consumer and
any other repo bound in `bots/*/repo`) was rewritten once during the cutover; see
[Migration](#migration). Because the Lambda and the runner share the parser, a consumer config in the
old form fails `register` and `prepare` until it is rewritten.

## Routes, receiver, poster and workflows

**Routes** stay `/<platform>/<bot>` (`ROUTE` in `receiver.ts` does not change). A Telegram bot keeps
its webhook URL, and a Slack app's event URL `<function URL>/slack/<bot>` is what the bot's name
already gives it. An existing bot gains Slack by adding a route, not by moving one.

**Receiver.** `loadBots` returns one connection view per connection; `createReceiver` builds one
`Chat` per connection, each on the shared state prefix `bot:<bot>:`, and `routeKey` is unchanged.
This reuses the one-adapter `createBotChat` as it is. `resolveRespondTo` reads the registry entry for
the connection's platform. The receiver still loads bots once per Lambda container (see the
[backlog](../TODO.md#backlog)), so a new connection is served only by containers started after it is
stored.

**`register`.** Reads the declared platforms, requires a connection with secrets for each, binds
`bots/<bot>/repo` as today (the conditional create is unchanged), writes the registry entry with a
per-platform `respond_to`, and calls `setWebhook` for a Telegram connection. A declared platform
without secrets fails the whole registration before any write. Re-registering every bot is a step of
the cutover, because it is the only writer of the new registry entry.

**Poster.** `post`, `read` and `unreact` derive the connection from the thread ID's prefix.
`start-thread` gains `platform` (derived from `fromThreadId`; with `destination` it is required when
the bot has several connections and defaults to the only one otherwise, like `--platform` on the CLI) and
`context` (the policy to store on the thread) and, from slice 11, `thread` (`new` or `persistent`,
default `new`). `loadBot(params, name, platform)` replaces
`loadBot(params, name)`. `read` also returns `policy`, the thread's stored policy, absent when none is stored. New
read-only `resolve-destination` (`bot`, `platform`, `name`) returns `{ threadId, chatId }` or
`{ found: false }` without creating anything, for the runner. Strict schemas still reject unknown
keys.

**Dispatch payload.** `{bot, thread_id, thread_key, message_id}` is unchanged: `bot` is still the
bot name, `thread_key` keeps its value, and the platform is the prefix of `thread_id`, validated
against `PLATFORMS`. So `centaur-message.yml`, the template in `workflows.md`, `centaur-pr-comment.yml`
and the concurrency group `centaur-<bot>-<thread key>` do not change, and the AGENTS.md rule about
payload changes is not triggered. If the maintainer prefers an explicit field (Decision 9), the
change is `platform` added in `message-handler.ts`, `dispatchPayload` in `prepare.ts`, the payload
lines in `plan.md` (receiver step 5) and `workflows.md`, and the two workflow files above for
completeness, with an optional field first so an old runner ignores it.

**Runner (`prepare`, `finish`, turn state).**

- Per-platform settings (`respond_to` for `canStaySilent`, `handle`) are read for the dispatched
  thread's platform. Scheduled turns read them for each target.
- The turn state's `start` changes from `{ destination }` to a list of targets
  `{ platform, name }`, or `{ fromThreadId }` for `/new`. `finish` posts the one reply to every
  target through `start-thread`, passing the prompt's `context`. A failure on one target does not
  stop the others, and the run fails at the end if any target failed (`notify-failure` as today).
  `link-pull-request` links the first target's thread. This is the turn state change `AGENTS.md`
  requires to be mirrored in `docs/workflows.md` "Turn state".
- A thread's policy is, in order: the latest `/resume` or `/transcript` in the thread, else the
  policy stored on the thread (`read`'s `policy`), else `context.default`. Only the fallback in
  `threadPolicy` changes.
- The `turn` action needs no new env entry or `finish` dep, because targets travel in the turn state.

**Rollout order.** The thread-key rollout showed that a runner using a field against a receiver that
does not send it breaks turns. Here the hazards run both ways: the Lambda must understand the new
poster fields before any runner uses them, and consumers run the actions from `@main`, so merging
runner code is the rollout. Slices are therefore marked Lambda or runner, and every runner slice that
calls a new poster field or operation merges only after the Lambda with it is deployed. Poster
requests tolerate the previous runner's missing optional fields (for example `platform` on a
single-connection bot), but data and configs have one form only; the slices that change them go live
together in the [cutover](#migration).

## Destinations

A destination name resolves, for one connection, with one lookup of the name at
`chats/<platform>/<name>` (a record with a chat and an optional thread, or a bare chat ID). The chat
must be approved for the connection and not blocked. A name that holds nothing is **created on first
use** ([Decision 18](#decisions)). The prompt's `thread` setting ([Decision 19](#decisions)) decides
how a run uses the destination:

| `thread` | Record has no `threadId` | Record has a `threadId` |
|---|---|---|
| `new` (default) | A new thread in the record's chat. | A new thread in the record's chat; the bound thread is ignored and untouched. |
| `persistent` | Create the thread in the record's chat, bind its `threadId` to the record, post into it. | Post into the bound thread. |

With no record, create on first use makes one: topic-less for `new`, with a created and bound thread
for `persistent`. The record's chat comes from the record, or from create on first use when there is
none.

**Create on first use.** The poster takes the connection's approved group chats (DMs excluded). With
exactly one, it writes the record with a conditional create under a state lock so two concurrent
runs create one. For `persistent` it also creates the thread first (Telegram `createForumTopic`,
named by the prompt's title or the destination name; Slack a top-level post, whose `ts` is the
thread). With none it fails naming `centaur access approve`; with several it fails naming
`centaur destination set`, since the bot cannot choose. A record that
already has a chat never goes through this step, so binding a thread to a destination whose chat is
known needs no group-chat count. A Telegram chat that is not a forum cannot hold a topic, so
`persistent` there fails with an error naming the chat.

**Persistent threads.** A prompt with `thread: persistent` posts every run into the record's
`threadId`. The thread
is marked bot-created through `thread-meta`, which also stores the prompt's `context` and the
destination name, with no expiry, so ownership and policy survive the 30-day Chat SDK thread-state
TTL that would otherwise end both on a monthly prompt. Each run rewrites the stored policy from the
prompt (the record's `context` mirrors it), so a thread shared by two prompts of different policy
uses the latest run's. Replies in any prompt-started thread (persistent or not) keep the prompt's
policy. This resolves the "thread policy storage" problem in TODO.md: the policy is stored with the
thread, not with the destination, because it is the prompt's setting, not the admin's.

**A scheduled run in a persistent thread** is a start-thread turn of a `thread: persistent` prompt
whose target has a thread. `prepare` calls `resolve-destination`; with a thread and a policy other than `fresh` it reads the
thread (transcript, bounded by [section 15](../DONE.md#15-bounded-transcript)), treats human
messages after the marker as history, advances the marker after the post and, for `resume`, restores
and saves the session under that thread. A scheduled workflow gets a `resolve` job
(the `resolve-schedule` action) that outputs the turn job's concurrency group. For a persistent
prompt it is `centaur-<bot>-<key>`, where the key hashes the bot and the sorted platform and
destination names of the prompt's targets (never a chat or thread ID), so runs of the prompt never
interleave in a thread, including the first run that creates it. A human reply is answered by a
chat turn in the per-thread group and is not serialized with the scheduled run; the marker makes
each turn handle every unprocessed message. A run with no thread yet uses the usual per-run branch.
The run reads the thread of its first target only.

**Binding an existing topic.** The Bot API cannot list topics, so binding one needs its ID, and the
CLI is the one way to bind it ([Decision 20](#decisions)); create on first use covers new persistent
threads:

- `centaur destination set <bot> <name> [--platform <p>] --chat <id> [--topic <id>]`, `list <bot>`
  and `remove <bot> <name>`. It only writes the record, since the CLI has no state-table access. The
  record's `threadId` is built from the platform and the IDs.
- **Finding the ID.** On Telegram, a message link in the topic, `t.me/c/<chat>/<topic>/...`, carries
  the chat and topic numbers. On Slack, the thread's message timestamp.

**Missing or closed topics.** On a Telegram post to a persistent destination, "thread not found" (a
deleted topic) creates a new topic and overwrites the record; "closed" first tries `reopenForumTopic`
and falls back to a new topic. The new thread starts without the old transcript. Slack channels that
are archived or inaccessible fail with the error. A live check on 2026-11-24 confirmed the Telegram
deleted-topic and not-a-forum strings and the Slack `channel_not_found` and `not_in_channel` errors.
A closed topic still accepts posts from a bot with topic rights, so it needs no reopen. Slack accepts
a reply under a deleted parent message without an error, so a deleted parent is not recreated; the
replies continue under Slack's "message deleted" stub. Checking the parent with `conversations.replies`
before posting could detect it, as a possible later change that is not planned. `TOPIC_CLOSED` for a
bot without topic rights and `is_archived` for a member bot remain unconfirmed
([TODO](../TODO.md#16-platforms-and-destinations)).

**Slack work.** The Slack items in section 12 (slash commands, onboarding, acknowledgement time) are
independent of this design. The two meet in two places: the per-connection signing secret (each bot
still has its own Slack app, so the manifest and `/slack/<bot>` URL are unchanged), and Slack
`!resume` and `!transcript`, which would share the text-command parser if that option is chosen.

## Migration

**Status: executed 2026-11-23.** The flat parameters were pruned the same day without a soak, and
the migration tooling (`bot migrate`, `config migrate`, `bot adopt`) was removed. This section is the
record of the approach.

Old and new code cannot both read the data, so the move was a one-shot cutover with a planned outage
for a single-owner setup, not a staged rollout. Three things changed together: the SSM records and
chat names (read by the Lambda), the registry entry in the state table (read by the receiver,
written only by `register`) and each consumer's `.centaur.yml` (parsed by `register` and by the
runner, which consumers run from `@main`).

### Options

| Option | Outage | Cost |
|---|---|---|
| **One-shot cutover with a backup (chosen)** | One window of about 5 to 10 minutes in which inbound messages are not answered. | No legacy code. Needs a quiet moment and a rehearsal. |
| Cutover shim: the Lambda reads both layouts and registry shapes, and the parser accepts both config forms, for one release, then a follow-up slice removes them | None. Deploy, data copy and consumer PRs can happen in any order and days apart. | Builds, tests and later deletes exactly the legacy readers the maintainer chose not to keep, and needs a second deploy to remove them. Not worth it for a window this small. |

A shim would only matter with many consumers or a bot that must not go quiet. With one owner and a
few consumer repos, the brief outage was accepted.

### Lessons

The order that worked: back up with `centaur bot export`, copy the data to the new layout while the
old Lambda still ignores it, deploy the new Lambda, copy again for approvals written in between,
merge the runner and each consumer's config (each merge runs `register`, which writes the new
registry entry and sets the Telegram webhook), then smoke-test every bot. Rollback is a redeploy of
the previous Lambda while the old data and registry entries exist; once the flat parameters are
pruned, only `centaur bot restore` from the backup brings them back. During the window inbound
messages are ignored, not queued, and a run that started on the old runner keeps working for
single-platform bots because `start-thread` takes the only connection when `platform` is absent.

### After the cutover

Each step below is independent and has its own revert.

1. **Add a platform to a bot.** `centaur bot add <bot> --platform slack` stores the Slack token and
   signing secret nested under the existing bot. Set the Slack app's event URL to
   `<function URL>/slack/<bot>`, add `platforms: {telegram: ..., slack: ...}` to the repo's config
   (each string `destination` becomes a per-platform map, as `centaur config check` says) and merge it so `register`
   runs. Force a cold start (deploy, or any function configuration update). Claim the Slack admin
   (`centaur admin claim <bot> --platform slack`) if none exists, and invite the bot.
   Revert: `centaur bot remove <bot> --platform slack`, revert the config.
2. **Use persistent destinations** per prompt: set `thread: persistent` on the prompt (to use an
   existing topic, bind it to the name with `centaur destination set` first), run it with `workflow_dispatch`,
   and check the topic. Revert: remove `thread: persistent`; delete the record with
   `centaur destination remove` if it was created for this.

Human steps: the deploys, the Slack app edits and secrets (a Slack app and its secrets only the
maintainer can create), the admin claim in each new connection, and test messages to the live bots.

## Alternatives considered

| Fork | Alternatives | Why the recommendation |
|---|---|---|
| Data model | **Nested connections under one bot** (`bots/<bot>/platforms/<p>/...`); flat layout with a platform suffix in every key (`bots/<bot>/slack-token`); keep bots single-platform and link them in a group (`garden` + `garden-slack` share a repo and config) | A group keeps every name and path and avoids data migration, but the config, persona, state history and thread keys would still be per name, `centaur bot add` would not become simpler, and "one bot" stays a convention. A flat suffix scheme mixes per-platform and per-bot keys in one directory. Nested has one rule for per-connection keys. |
| Receiver structure | **One `Chat` per connection on the shared bot prefix**; one `Chat` with several adapters | Per-connection reuses the one-adapter code unchanged (access, admin channel, ownership). A multi-adapter `Chat` needs every handler to branch on `thread.adapter.name`. |
| Destination key | **By name, per connection**; by chat (topics attached to an approved chat); by name, global | By-chat allows only one persistent topic per chat and cannot say "the same name on two platforms". A global name collides across bots, which each create their own topics. |
| Naming a chat | **Names in configs, resolved to IDs in SSM**; native platform identifiers in configs | Telegram has no name for a private group: `chat_id` is an integer or the `@username` of a public channel or supergroup only, and topics are numeric. Slack `chat.postMessage` accepts an encoded ID or, for public channels only, a channel name; private channels need the ID, and a name changes when the channel is renamed. Raw IDs in a repo would expose chat IDs in public repos and tie a config to one deployment's chats. |
| Persistence | **An explicit prompt-level `thread: new \| persistent`** (default `new`); a structured destination object with a `thread` ID in the config; persistence implicit by name (a new name or a bound topic means persistent) | A thread ID in the config violates Decision 18: IDs stay out of public repos and deployments differ. Implicit persistence changes behavior silently when a name is changed or a topic is bound, and the config does not show what a prompt does. |
| Policy storage | **A `thread-meta` record**; Chat SDK thread state; the destination record | Thread state expires after 30 days, which loses ownership and policy for a monthly prompt. A destination record is the admin's, but the policy is the prompt's, and it would not cover threads that are not destinations. |

## Decisions

Accepted on 2026-11-22, as recommended, with one amendment: there is no backwards compatibility.
The maintainer approved the nested SSM layout and chose to migrate existing data and configs once
instead of keeping the old forms working. So the code never reads the flat SSM layout, a flat chat
alias, an old registry entry or the legacy top-level config keys; old config keys fail with an error
that names the replacement. "Configs" covers both the bots' SSM records and state-table
keys and the consumer `.centaur.yml` files. Decisions that relied on compatibility are amended below.

1. **SSM layout: nested connections** under `bots/<bot>/platforms/<platform>/`. Only the nested
   layout is read and there is no mixing; the flat layout was copied once.
   Alternatives above.
2. **Receiver: one `Chat` per connection**, sharing `bot:<bot>:`.
3. **One state prefix per bot**, shared by connections (keeps `garden`'s history), rather than a
   prefix per connection. State keys other than `registry:<bot>` are unchanged, so they need no
   migration.
4. **Config shape: a `platforms` map only.** The legacy top-level `platform`, `respond_to` and
   `handle` are rejected, with an error naming the replacement; there is no normalization.
5. **Prompt destination: a name or a per-platform map.** A string is valid only when the bot declares
   exactly one platform; a bot with several uses the map, where one entry is one target and several
   are a fan-out. The alternative, fan out to every declared platform, would make adding Slack change
   where existing prompts post. `resume` with several targets is rejected. (Amended by Decision 19.)
6. **Fan-out: one turn, one reply posted to every target**; a failed target fails the run after the
   others post; the pull request links to the first target.
7. **Destinations are named per platform** in the single store `chats/<platform>/<name>`; topic-bound
   records carry `bot`. The flat form is migrated and then not read. (Amended by Decision 18.)
8. **Create on first use only when the connection has exactly one approved group chat.** Otherwise an
   error names the commands. Whether a run opens a fresh thread or posts into the destination's one
   persistent thread is the prompt's `thread` setting, not the name and not the record alone.
   (Amended by Decisions 18 and 19.)
9. **Dispatch payload unchanged**; derive the platform from `thread_id`'s prefix. The alternative is
   an explicit optional `platform` field (files listed above).
10. **Thread context policy in a `thread-meta` state record**: 90-day TTL refreshed on read, no TTL
    for destination threads. Precedence: latest in-thread command, else stored, else
    `context.default`. A thread shared by two prompts uses the latest run's policy. (Amended: for a
    scheduled run the prompt's context replaces the stored policy, which the run rewrites; a human
    command in the thread still wins.)
11. **Missing or closed Telegram topic: reopen if closed, else recreate**, update the record and
    start with no transcript; Slack archived channels fail with the error. A closed topic needs no
    reopen for an admin bot. (Amended by live check, 2026-11-24.)
12. **`centaur destination set` may replace an existing binding**, rather than refusing until it is
    removed. (Amended by Decision 20.)
13. **No Slack binding command.** Slack has no in-chat binding by text or slash command; the CLI
    binds. (Amended by Decision 20.)
14. **Merging a Slack-only bot into the main bot starts old Slack threads fresh**: no copy of state,
    sessions or branches; open pull requests are merged or closed first. The command that
    copied a connection for this (`bot adopt`) was removed; a Slack-only bot is re-added with
    `bot add --platform slack`.
15. **Undeclared connections are not served**: the receiver serves the platforms in the registry
    entry. An entry without `platforms` (the old shape) serves nothing until `register` rewrites it.
16. **Section 9's open item** ("check `destination` aliases against SSM at register time"):
    **no**. With create-on-first-use a destination name can be legitimately unresolved at register;
    `register` checks only that each declared platform has a connection.
17. **Order against section 15**: ship persistent threads that use `transcript` or `resume` only
    after bounded transcript 3, because a weekly thread's transcript grows without bound. The
    earlier slices have no such dependency.

18. **Aliases fold into destinations in slice 11** (maintainer ruling; details approved by the
    maintainer, 2026-11-23): after slice 11 the
    only concept is the destination, a named record per platform holding a chat ID and an optional
    topic or thread ID; a destination with no topic is what an alias is. Telegram has no native name
    for a private group (only numeric chat IDs, and `@username` for public channels), and Slack names
    change and cannot address private channels, so configs keep using names and the IDs stay in SSM,
    out of public repos and portable between deployments. Slice 8 is unchanged and remains the
    cutover's migration target and the base of slice 11. The details are:
    - **(a) Storage:** keep `chats/<platform>/<name>` as the one destination store and widen the value
      from a bare chat ID to a JSON record `{ chatId, threadId?, bot?, context?, name, at }`. A bare
      chat ID reads as a topic-less destination, so no second data migration follows the cutover;
      writes after slice 11 use the record. A record with `threadId` also carries `bot`, since a
      topic belongs to the bot that created or bound it (the old per-bot path was chosen for this);
      another bot resolving it fails with an error naming the owner. `context` is the prompt's
      stored policy for the persistent thread, mirrored from `thread-meta` (Decision 10), which stays
      the source for replies. Rejected: the per-bot path `bots/<bot>/platforms/<p>/destinations/<name>`,
      which needs a second migration assigning every existing alias to a bot (approvals can be shared
      by several bots) and a second place to look up a name.
    - **(b) Creation:** approving a chat creates a topic-less destination named from the chat title,
      with the name derivation and collision handling unchanged (`-2` suffix, an existing name for the
      same chat is reused, an explicit name for a different chat is refused). `centaur destination
      set` binds a topic by writing the record (Decision 20);
      create-on-first-use of a persistent topic is as designed above.
    - **(c) CLI:** `centaur chat list` is subsumed by `centaur destination list|set|remove` (slice 14)
      and removed there, a breaking CLI change. `access approve --alias` is removed, not renamed;
      `centaur destination set` is the one way to name an existing topic or thread. No old spelling
      is kept, as there is no backwards compatibility. (Amended by Decision 20.) The word "alias" was removed from docs and messages in slice 17.
    - **(d) Config:** no change: `destination: <name>` and the per-platform map keep working.
    - **(e) Resolution:** one lookup of the name at `chats/<platform>/<name>`; if absent, create on
      first use under the rules of Decision 8 (exactly one approved group chat, else an error naming
      the commands). Whether a run reuses a bound `threadId` is the prompt's `thread` setting
      (Decision 19).
    - **(f) Cutover:** no impact beyond slice 8. Existing aliases become destinations by
      reinterpreting the stored bare value; the migration, `--alias-platform` and `--prune` are
      unchanged.
    - **(g) Code:** in slice 11, `src/lambda/chat-aliases.ts` becomes `destinations.ts` (merged with the
      planned new file): `resolveChatAlias` becomes `resolveDestination`, `proposeChatAlias` becomes
      `proposeDestinationName`, `recordChatAlias` becomes `recordDestination`, `slugAlias` becomes
      `slugName`; `src/cli/chat-aliases.ts` (`knownChatAliases`) becomes
      `src/cli/destinations.ts`; `src/cli/commands/chats.ts` (`chat list`) was removed in slice 14.
      The `bots/*/platforms/*/destinations/*` IAM statement is not needed, because the Lambda role's
      `chats/*` wildcard already covers the store; `test/infra.test.ts` is unchanged.

19. **An explicit `thread` setting; no prompt-level `platforms`** (approved by the maintainer, 2026-11-23, all five points).
    - **`thread: new | persistent` (default `new`) on a prompt.** Whether a scheduled prompt posts a
      fresh thread each run or into the destination's one persistent thread is visible in the
      prompt's config instead of implied by a name or by what the record happens to hold. A rename
      or a `centaur destination set` binding would otherwise change behavior silently. Chat and
      thread IDs stay out of the config (Decision 18): the destination name still resolves to a
      record in SSM, bound by `centaur destination set` or created on first use. Example: `hello: { destination: { slack: centaur-test-slack }, thread: persistent }`.
      The semantics below are approved:
      - **`persistent`** posts every run into the record's thread. If the record has no thread,
        create on first use creates one in the record's chat and binds it to the record, under the
        limits of Decision 8 (those apply only when there is no record and so no chat). Slack uses a
        persistent thread (slice 12). The record's stored context policy is the prompt's, rewritten
        on every run (Decision 10).
      - **`new`** opens a fresh thread per run, as a destination with no thread does, and never reuses a bound
        thread, so one destination can serve a `persistent` prompt and a `new` prompt. A record bound
        to a topic with a `new` prompt: the prompt wins, the run posts a new thread in the record's
        chat and leaves the bound thread alone.
      - **Fan-out:** `thread` applies to every target of the prompt. A per-target override (for
        example `destination: { telegram: { name: household, thread: persistent } }`) is out of
        scope and a later option.
    - **No prompt-level `platforms` selector.** A string `destination` is valid only when the bot
      declares exactly one platform; a bot with several platforms uses the per-platform map
      `destination: { <platform>: <name> }`, where one entry is one target and several are the
      fan-out of slice 15. The selector was a second way of saying the same thing as the map, and
      the map form is the one that survives adding a platform. The top-level `platforms:` map of
      connections is unchanged.

20. **No in-chat `/destination` or `!destination` commands** (maintainer ruling, 2026-11-24; slice
    13 is dropped). `centaur destination set` is the one way to bind an existing topic or thread, and
    create on first use covers new persistent threads. The Bot API cannot list topics, so binding an
    existing topic needs an ID from the CLI, and a Telegram message link carries it. The handlers
    would add admin authorization and pre-ownership receiver code for a rare need, and they can
    return later because nothing depends on their absence. `centaur chat list` and `access approve
    --alias` are removed in slice 14, so the word "alias" leaves the CLI.

### Open after amendment

No accepted Decision became contradictory. Three things the amendment leaves open, each with a
recommendation, tracked as **[HUMAN APPROVAL]** in [TODO.md](../TODO.md#16-platforms-and-destinations):

- **The registry entry could not be migrated by the CLI** (it lives in the state table, which the CLI
  cannot reach). Recommendation: `register` rewrites it, so re-registering every bot is a cutover
  step, and the bots stay silent from the Lambda deploy until it runs.
- **A flat chat alias whose platform could not be inferred** (no bot's approved chats contain its chat
  ID). The maintainer assigned or dropped each during the cutover.
- **The set of consumer repos.** Recommendation: enumerate them from `bots/*/repo` in SSM and rewrite
  each by hand; a consumer not bound to any bot is out of scope.

## Implementation plan

The slices below are all built except 13 (dropped) and the live checks of 19. The plan is kept as
it was written; the gates describe the order the slices were merged and deployed in. "Lambda" slices change what is deployed with `yarn deploy-prod`; "runner" slices change the actions
and `prepare`/`finish` and are live as soon as they merge to `main`. Because data and configs have
one form, slices 1 to 8 are not independently mergeable: they are built as stacked pull requests
into the branch `platforms/cutover`, each with tests and docs, and go live together in slice 18.
Slices 9 to 17 branch from `main` after slice 18, are independently mergeable, and a runner slice
merges only after the Lambda it calls is deployed. Slices that share a file are listed and must be
serialized; the others can run in parallel.

| # | Slice | Kind | Likely files | After |
|---|---|---|---|---|
| 1 | Config schema: `platforms` map only, legacy top-level keys rejected with an error naming the replacement, destination string or map, errors (the prompt `platforms` selector it first included is removed by slice 21); readers (`register.ts`, `prepare.ts`) take per-platform settings | Both | `src/config/schema.ts`, `src/config/index.ts`, `src/lambda/register.ts`, `src/workflows/prepare.ts`, `test/config.test.ts`, `test/helpers/config-fixtures.ts`, `docs/config.md` | none |
| 2 | Connection model and loader: nested layout only, connection view, per-connection path helpers | Lambda | `src/lambda/registry.ts`, `parameters.ts`, `access-entries.ts`, `access.ts`, `test/helpers/receiver-fixtures.ts`, `poster-fixtures.ts` | none (parallel with 1) |
| 3 | CLI connections: `bot add` onto an existing bot, `bot list`, `bot remove --platform`, `--platform` on `access` and `admin claim`, `chat list` for scoped chat names (removed in slice 14) | CLI | `src/cli/commands/bot.ts`, `access.ts`, `admin.ts`, `src/cli/registry.ts`, `docs/cli.md` | 2 |
| 4 | CLI migration tools: `bot export` and `bot restore` (backup of every bot's SSM parameters, chats and admin entries; kept), plus `bot migrate`, `config migrate` and `bot adopt` (Decision 14), single-use and removed by slice 20 | CLI | `src/cli/commands/bot.ts`, new `src/cli/commands/config.ts`, `docs/cli.md` | 3 (same files), 1 for `config migrate` |
| 5 | Registry entry per platform and `register` over declared platforms; an old-shape entry serves nothing | Lambda | `src/lambda/register.ts`, `registry.ts`, `docs/poster.md` | 1, 2 |
| 6 | Receiver: one `Chat` per connection, per-platform `respond_to` | Lambda | `src/lambda/receiver.ts`, `chat.ts`, `message-handler.ts`, `test/receiver*.test.ts`, `docs/plan.md` | 2, 5 |
| 7 | Poster derives the connection from the thread ID; `start-thread` takes `platform` (optional on a single-connection bot) | Lambda | `src/lambda/poster.ts`, `registry.ts`, `docs/poster.md` | 2 (after 5, same `registry.ts`) |
| 8 | Platform-scoped chat names (flat form not read) and the resolution order; folded into destinations in slice 11 | Lambda, CLI | `src/lambda/chat-aliases.ts`, `access-decisions.ts`, `poster.ts`, `src/cli/chat-aliases.ts`, `commands/access.ts`, docs | 2, 7 |
| 9 | `thread-meta` record: `start-thread` stores `context`, `read` returns `policy`, ownership reads it | Lambda | new `src/lambda/thread-meta.ts`, `poster.ts`, `ownership.ts`, `message-handler.ts`, `docs/poster.md`, `docs/workflows.md` | 18 |
| 10 | Runner reads the stored policy; scheduled runs pass `context` to `start-thread`: closes the thread-policy gap for every prompt | Runner | `src/workflows/prepare.ts`, `finish.ts`, `transcript.ts`, `docs/workflows.md`, `docs/plan.md` | 9 deployed |
| 11 | Replace aliases with destinations (Decision 18): widen the `chats/<platform>/<name>` value to a record, rename `chat-aliases.ts`, `resolveChatAlias`, `proposeChatAlias`, `recordChatAlias` and `slugAlias` to destination names, one-lookup resolution, create on first use, recreate (Telegram), `resolve-destination` and `start-thread` take `thread` (Decision 19: persistent binds a thread, new never reuses one); the schema parses and validates `thread: new \| persistent` (default `new`) and rejects `persistent` with an error naming slice 16 until it lands, since accepting and ignoring it would post new threads silently; no new IAM statement | Lambda | `src/config/schema.ts`, `docs/config.md`, `src/lambda/chat-aliases.ts` renamed `destinations.ts`, `access-decisions.ts`, `access-requests.ts`, `poster.ts`, `telegram.ts`, `src/cli/chat-aliases.ts` renamed `destinations.ts`, `src/cli/commands/access.ts`, `docs/poster.md`, `docs/deploy.md` | 8, 9, 18 |
| 12 | Slack persistent thread (the `persistent` mode of `start-thread` on Slack) and Slack post-into-thread | Lambda | `src/lambda/destinations.ts`, `poster.ts` | 11 |
| 13 | Dropped (Decision 20): the in-chat `/destination` and `!destination` handlers | | | |
| 14 | `centaur destination set\|list\|remove`, the one way to bind an existing topic or thread; removes `centaur chat list` and `access approve --alias` (breaking) | CLI | new `src/cli/commands/destination.ts`, `program.ts`, `docs/cli.md` | 11 |
| 15 | Multi-target scheduled turns: targets in the turn state, fan-out in `finish`, per-platform settings in `prepare` | Runner | `src/workflows/prepare.ts`, `turn-state.ts`, `finish.ts`, `cli.ts`, `docs/workflows.md`, `docs/plan.md` | 10 |
| 16 | `thread: persistent` scheduled turns: `prepare` and `finish` pass the prompt's `thread`; history, marker and session under the destination thread, `resolve` job and concurrency template; the schema stops rejecting `persistent`. Built: `prepare` finds the bound thread with `resolve-destination`, `resolve-schedule` computes the group | Runner | `src/config/schema.ts`, `src/workflows/prepare.ts`, `finish.ts`, `schedule-group.ts`, `cli.ts`, `.github/actions/resolve-schedule`, `docs/workflows.md`, `docs/config.md`, the self-consumer workflow | 11, 15, bounded transcript 3 |
| 17 | Docs sweep: `onboarding.md` (add a platform, bind a topic), `plan.md` SSM layout, receiver and access sections, `config.md`, `cli.md`, `poster.md`, README; remove the word "alias" everywhere (Decision 18); mark this doc as built. Built | Docs | `docs/*.md`, `README.md` | all |
| 18 | Cutover: the runbook in [Migration](#migration), run once by the maintainer after a rehearsal | Human | | 1 to 8 |
| 19 | Live checks on the test bot: two platforms on one bot, a persistent topic and Slack thread, deleted and closed topic error strings (error strings and closed or deleted behavior verified 2026-11-24; the end-to-end persistent run remains) | Human | | 12, 16 |
| 20 | Remove the one-time migration tooling: `bot migrate`, `config migrate` (and the `diff` dependency) and `bot adopt`, with their tests, fixtures and docs; the legacy-key errors no longer name a command; the `alias` schema helper becomes `slug`. `bot export` and `bot restore` stay as a general backup. Built | CLI | `src/cli`, `src/config/schema.ts`, `test/`, `docs/` | 18 |
| 21 | Config simplification (Decision 19): remove the prompt `platforms` selector, a string `destination` only for a one-platform bot, the map otherwise; update `docs/config.md`, tests, the self-consumer config. Built, independent of the cutover and the later slices. | Both | `src/config/schema.ts`, `src/config/index.ts`, `test/config.test.ts`, `test/helpers/config-fixtures.ts`, `.centaur/config.yml`, `docs/config.md` | none |

Parallel groups: {1, 2}; then {3, 5}; then {4, 6, 7}; then 8; then 18; then {9}; then {10, 11}; then
{12, 14, 15}; then 16, 17, 19. Slice 21 branches from `main` now and is independent of all of them; it
shares `src/config/schema.ts` with slices 11 and 16, so those start after it merges. A consumer config that still has the prompt `platforms` selector fails once 21 is deployed, so rewrite it first.
Deploy gates: (a) nothing from slices 1 to 8 reaches `main` or a deploy before the cutover go
decision and a passed rehearsal (a backup and a dry run against production, and the copy and a
deploy-and-register against a test bot); (b) the cutover deploys the Lambda from
`platforms/cutover` before that branch merges to `main`; (c) after the cutover, each Lambda slice (9,
11, 12) is deployed and checked before the runner slices that call it (10, 15, 16) merge.

## What could not be determined from the code

- Whether `garden-slack` exists, which repo it is bound to, and whether `centaur-hello` and the
  self-consumer (`bot: centaur-slack`) share bots. A repo's config names one `bot`, so folding
  `garden-slack` into `garden` also means deciding which repo answers on Slack.
- Whether `state.set` without a TTL never expires in `@blevinstein/chat-state-dynamodb`; it needs a
  read of the adapter.
- Verified live on 2026-11-24: the Telegram deleted-topic and not-a-forum strings, that a closed
  topic accepts admin-bot posts, the Slack `channel_not_found` and `not_in_channel` errors, and that
  a reply under a deleted Slack parent succeeds silently. Still unconfirmed: `TOPIC_CLOSED` for a bot
  without topic rights and `is_archived` for a bot in an archived channel.
- Whether a Chat SDK dedupe key includes the adapter name; two `Chat` instances on one prefix rely on
  it, and one test should pin it.
