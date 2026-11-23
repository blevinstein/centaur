# Bots across platforms and topic destinations (design)

> **Status: Decisions accepted, nothing built yet.** Nothing described here exists in the code. The
> SSM layout, config keys, poster fields, commands and CLI commands below are the accepted design,
> and the code does not implement them. Existing data and configs are migrated once; the old forms
> are not kept working (see [Decisions](#decisions) and [Migration](#migration)). Terms (receiver, poster, turn, state table, alias) are defined in
> [plan.md](plan.md), [poster.md](poster.md) and [workflows.md](workflows.md).

Two items from [TODO.md](../TODO.md) are designed together because they change the same records:
one bot present on several platforms, and named destinations that can point at a topic or thread
inside a chat.

## Problem and goals

A bot is one SSM record with a single `platform`, one set of secrets and one repo, so the same bot
cannot be on Telegram and Slack. Each platform needs its own bot name (`garden`, `garden-slack`),
and `centaur bot add` refuses a name that exists. A prompt's `destination` names a chat alias, so a
recurring prompt opens a new topic or message on every run instead of keeping one persistent thread,
and a scheduled prompt's context policy applies only to its first turn: replies in the thread fall
back to `context.default` because the policy is not stored.

Goals:

1. One bot with several platform connections (each with its own secrets, webhook route, approved
   chats and users, and aliases), one repo binding, one config and one persona.
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

## What assumes one platform per bot today

| Where | Assumption |
|---|---|
| `.centaur.yml` (`src/config/schema.ts`) | `bot` plus one top-level `platform`, `respond_to` and `handle`; prompt `destination` is one chat alias. |
| SSM (`src/lambda/registry.ts`, `src/cli/registry.ts`) | `bots/<bot>/platform`, `token`, `webhook-secret` or `signing-secret`; `Bot` has one `platform`. `centaur bot add` refuses an existing name. |
| Access (`src/lambda/access.ts`, `access-entries.ts`) | `bots/<bot>/approved-chats/<id>`, `approved-users/<id>`, `blocked/...` have no platform; the admin is looked up by `bot.platform`. |
| Receiver (`src/lambda/receiver.ts`, `chat.ts`) | One `Chat` per bot with one adapter, `chat.webhooks[bot.platform]`, one route `/<platform>/<bot>`, `ADMIN_CHANNELS[bot.platform]`. |
| Message handling (`message-handler.ts`, `access-requests.ts`, `admin-claims.ts`, `ownership.ts`) | `bot.platform` slices chat IDs from `channelId`, picks the admin, and decides thread-scoped ownership. |
| Registry entry | State `registry:<bot>` holds one `{respond_to}`. |
| `register` (`src/lambda/register.ts`) | Requires `secrets.platform === config.platform`; sets one webhook for Telegram. |
| Poster (`src/lambda/poster.ts`) | `loadBot(name)` returns one platform; `THREAD_OPENERS[bot.platform]`; `start-thread` takes a chat alias. |
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
- **Chat alias**: today's global `chats/<alias>` name for a chat. It stays, as a destination with no
  topic.

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
| `bots/<bot>/platforms/<platform>/destinations/<name>` | String (JSON) | `/destination`, `centaur destination set`, first-use creation, topic recreation |
| `chats/<platform>/<alias>` | String | access request approval; `centaur access approve` |
| `admin/<platform>`, `admin-claim/<platform>`, `github/token` | | unchanged |

The previous flat layout (`bots/<bot>/platform`, `token`, `webhook-secret`, `signing-secret`,
`approved-chats/...`, `approved-users/...`, `blocked/...`) is not read. `centaur bot migrate` copies
it to the nested paths once (see [Migration](#migration)); a bot with only flat parameters has no
connection and is not served.

A connection is addressed by its base path `bots/<bot>/platforms/<platform>`, and every
per-connection key hangs off it. The code keeps the existing `Bot` shape as
the **connection view** (`name`, `platform`, `repo`, `token`, `webhookSecret`): `loadBots` returns one
per connection, so the access resolver, access requests, admin claims, ownership and message handler
keep taking a single-platform `Bot` and change little.

Destination record (JSON):

| Field | Meaning |
|---|---|
| `chatId` | The chat or channel ID, in the platform's own form. |
| `threadId` | Optional. The platform thread ID of the persistent thread (`telegram:<chat>:<topic>`, `slack:<channel>:<ts>`). Absent means chat-level: each run starts a new thread, exactly like a chat alias. |
| `name`, `at` | Display name and time of the last change, as in access entries. |

Chat aliases become platform-scoped for new approvals (`chats/<platform>/<alias>`), so `household` can
name a Telegram group and a Slack channel without the `-2` suffix. The flat `chats/<alias>` is not
read; migration copies each to `chats/<platform>/<alias>`, taking the platform from the bots whose
approved chats contain the alias's chat ID. The existing "chat is approved for this connection" check rejects an
alias that points at another platform's chat. The Lambda role's `chats/*` wildcard already covers the
nested path.

IAM: IAM `*` in a resource ARN also matches `/`, so the statements on
`bots/*/approved-chats/*`, `approved-users/*` and `blocked/*` already match the nested paths, but
the destination path needs its own `ssm:PutParameter` statement
(`bots/*/platforms/*/destinations/*`) and `test/infra.test.ts` / `yarn lint:cfn` must be rerun.

### State table

| Key (prefix `bot:<bot>:`) | Content |
|---|---|
| `registry:<bot>` (empty prefix, unchanged name) | `{ platforms: { <platform>: { respond_to } } }`. An old entry `{ respond_to }` is not read: the bot counts as unregistered until `register` rewrites the entry. The CLI has no state-table access, so migration cannot do it. |
| `thread-meta:<threadId>` | `{ context?, destination? }`: the thread's stored context policy and, for a persistent destination thread, its name. TTL 90 days refreshed on read; none for destination threads. |
| Everything else (dedupe, subscriptions, `thread-state:`, access requests, transcripts) | Unchanged. |

All connections of a bot share the prefix `bot:<bot>:`. Keys are made of IDs that are already
platform-prefixed (thread, message and channel IDs) or distinct in form (Slack `U...`/`C...` against
numeric Telegram IDs), so sharing one prefix is collision-free, and it keeps `garden`'s stored
history and markers.

### Access, aliases and the admin per platform

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
    platforms: [telegram, slack]
    destination: weekly-plan            # the same name on each listed platform
    context: transcript
  frost-alert:
    destination:                        # or one name per platform
      telegram: household
      slack: garden-alerts
```

- `platforms` is a map from `telegram`/`slack` to `{respond_to?, handle?}` (strict). Its keys are the
  connections the repo expects; `register` fails if one has no secrets in SSM, and the receiver
  serves a connection only while the registry entry lists it.
- Per-platform settings are exactly today's platform-bound ones: `respond_to` (default `mention`) and
  `handle`. Everything else (`context`, `provider`, `model`, tools, MCP, `pull_requests`) stays
  bot-wide.
- A prompt's `destination` is a name or a map from platform to name. `platforms` on a prompt lists
  where a string destination applies; it is required when the bot declares more than one platform and
  the destination is a string, and must not be combined with the map form. The parser enforces this,
  so adding a second platform to an existing config makes `centaur config check` point at each prompt
  that needs it, instead of silently posting to a new place.
- The same resolution rule applies per platform: a name that resolves to a destination record uses
  it; otherwise a chat alias is a chat-level destination; otherwise the name is a topic destination
  created on first use (see [Destinations](#destinations)).
- A prompt with more than one target and `context: resume` is a config error: a session belongs to
  one thread.

**No legacy keys.** The parser accepts only this schema. The old top-level `platform`, `respond_to`
and `handle` are rejected with an error that names the replacement
(`platforms: { <platform>: { respond_to, handle } }`) and points at `centaur config migrate`, which
rewrites a config file in place (comments kept). A string `destination` stays valid (it is a name,
and needs `platforms` on the prompt only when the bot declares several platforms), so the rewrite
touches only those three keys. Every consumer repo (`garden`, `centaur-hello`, the self-consumer and
any other repo bound in `bots/*/repo`) is rewritten once during the cutover; see
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
`context` (the policy to store on the thread). `loadBot(params, name, platform)` replaces
`loadBot(params, name)`. `read` also returns `policy`, the thread's stored policy or `null`. New
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

A destination name resolves, for one connection, in this order:

1. A destination record `bots/<bot>/platforms/<platform>/destinations/<name>`: chat, optional thread.
2. A chat alias (`chats/<platform>/<name>`, then flat `chats/<name>`): a chat-level destination. The
   chat must be approved for the connection and not blocked, as today. Every run starts a new topic
   or message, which keeps all existing configs unchanged.
3. Otherwise, **create on first use**: the name is a persistent topic destination.

**Create on first use.** The poster takes the connection's approved group chats (DMs excluded). With
exactly one, it creates the topic (Telegram `createForumTopic`, named by the prompt's title or the
destination name) or the first message (Slack top-level post, whose `ts` is the thread), then writes
the record with a conditional create under a state lock so two concurrent runs create one topic.
With none it fails naming `centaur access approve`; with several it fails naming
`/destination <name>` and `centaur destination set`, since the bot cannot choose.

**Persistent threads.** A record with a `threadId` makes every run post into that thread. The thread
is marked bot-created through `thread-meta`, which also stores the prompt's `context` and the
destination name, with no expiry, so ownership and policy survive the 30-day Chat SDK thread-state
TTL that would otherwise end both on a monthly prompt. Each run rewrites the stored policy from the
prompt, so a thread shared by two prompts of different policy uses the latest run's. Replies in any
prompt-started thread (persistent or not) now keep the prompt's policy. This resolves the "thread
policy storage" problem in TODO.md: the policy is stored with the thread, not with the destination,
because it is the prompt's setting, not the admin's.

**A scheduled run in a persistent thread** is a start-thread turn whose target already has a thread.
`prepare` calls `resolve-destination`; with a thread and a policy other than `fresh` it reads the
thread (transcript, bounded by [section 15](../TODO.md#15-bounded-transcript)), treats human
messages after the marker as history, advances the marker after the post and, for `resume`, restores
and saves the session under that thread. A scheduled workflow for such a prompt gets a `resolve` job
that outputs `thread_key`, and its turn job uses `concurrency: centaur-<bot>-<thread key>` (the
pattern `centaur-pr-comment.yml` uses), so a run and a human reply to the same thread are serialized.
A run with no thread yet uses the usual per-run branch and needs no group.

**Binding an existing topic.** The Bot API cannot list topics, so an admin binds one from inside it:

- **Telegram:** `/destination <name>` in a topic. A message from the admin (user ID from the signed
  webhook), in an approved, unblocked group. The chat comes from the thread's channel and the topic
  from the thread ID; it writes the record and the thread's `thread-meta`, and replies with the name
  and whether it replaced a binding. In the General topic it binds the chat (no `threadId`), which is
  a chat-level destination. `/destination` alone replies with this thread's name. Anyone else gets
  no reply.
- **Slack:** the text form `!destination <name>` in the thread, admin only, handled in the receiver
  before ownership like the admin claim, so it works without a registered slash command (Slack
  intercepts messages starting with `/`; see section 12).
- **CLI:** `centaur destination set <bot> <name> [--platform <p>] --chat <id> [--topic <id>]`,
  `list <bot>` and `remove <bot> <name>`. It only writes the record, since the CLI has no state-table
  access. The record's `threadId` is built from the platform and the IDs.

**Missing or closed topics.** On a Telegram post to a persistent destination, "thread not found" (a
deleted topic) creates a new topic and overwrites the record; "closed" first tries `reopenForumTopic`
and falls back to a new topic. The new thread starts without the old transcript. Slack channels that
are archived or inaccessible fail with the error; a deleted parent message is not recreated until the
behavior is verified on a real workspace. The exact Bot API error strings must be confirmed on a live
bot ([**HUMAN ACTION**](../TODO.md#16-platforms-and-destinations)).

**Slack work.** The Slack items in section 12 (slash commands, onboarding, acknowledgement time) are
independent of this design. The two meet in three places: the Slack form of `/destination` (a text
command, so it does not depend on slash-command registration), the per-connection signing secret
(each bot still has its own Slack app, so the manifest and `/slack/<bot>` URL are unchanged), and
Slack `!resume` and `!transcript`, which would share the text-command parser if that option is
chosen.

## Migration

Old and new code cannot both read the data, so the move is a one-shot cutover with a planned outage
for a single-owner setup, not a staged rollout. Three things change together: the SSM records and
chat aliases (read by the Lambda), the registry entry in the state table (read by the receiver,
written only by `register`) and each consumer's `.centaur.yml` (parsed by `register` and by the
runner, which consumers run from `@main`).

### Options

| Option | Outage | Cost |
|---|---|---|
| **One-shot cutover with a backup (recommended)** | One window of about 5 to 10 minutes in which inbound messages are not answered. | No legacy code. Needs a quiet moment and a rehearsal. |
| Cutover shim: the Lambda reads both layouts and registry shapes, and the parser accepts both config forms, for one release, then a follow-up slice removes them | None. Deploy, migrate and consumer PRs can happen in any order and days apart. | Builds, tests and later deletes exactly the legacy readers the maintainer chose not to keep, and needs a second deploy to remove them. Not worth it for a window this small. |

A shim would only matter with many consumers or a bot that must not go quiet. With one owner and a
few consumer repos, the brief outage is accepted. If the rehearsal shows the window is longer than
about 15 minutes, revisit.

### Cutover sequence (slice 18)

Before the window, with no outage:

1. **Rehearse.** Run `centaur bot export` and `centaur bot migrate --dry-run` against production
   (read-only), and the full sequence below against a test bot. The dry run lists every copy and any
   chat alias whose platform cannot be inferred.
2. **Prepare.** List the consumers from `bots/*/repo`, and open one pull request per consumer that
   runs `centaur config migrate` on its config, unmerged. Pick a moment with no scheduled prompt due
   and no turn in flight, and tell the bots' chats.
3. **Back up.** `centaur bot export` writes every bot's parameters (secrets included) and the chat
   aliases to a local file with mode 0600 outside any repo. It is the restore source for
   `centaur bot restore`.
4. **Copy.** `centaur bot migrate` copies each flat parameter and alias to the nested paths and
   verifies each copy; the flat ones stay in place. The running old Lambda ignores the nested copies,
   so nothing changes yet.

The window:

5. **[HUMAN APPROVAL] Go.** The maintainer says go.
6. **Deploy** the Lambda from `platforms/cutover` (`yarn deploy-prod`; the window starts). The
   receiver now reads only nested connections, and every registry entry still has the old shape, so
   no bot is served.
7. **Copy again** (`centaur bot migrate`) to pick up approvals the old Lambda wrote after step 4. It
   only adds entries missing from the nested layout.
8. **Merge** `platforms/cutover` to `main` (the runner is live; an old-form config now fails with the
   migration error, which is harmless while nothing is dispatched), then merge each consumer pull
   request. Each merge to a default branch runs `register`, which writes the new registry entry and
   sets the Telegram webhook, and the window ends bot by bot. A consumer whose register run does not
   start is started with `workflow_dispatch`.
9. **Smoke test:** send a message to each bot, `workflow_dispatch` one scheduled prompt per consumer,
   and check a chat alias resolves.

What fails during the window (steps 6 to 8): inbound messages are ignored, not queued, so they must
be resent; a turn that was already dispatched can still finish against the new Lambda but may fail
on a flat alias; scheduled runs and PR comment turns that start in the window fail at `register`'s or
`prepare`'s config error. A run that started on the old runner and the new Lambda keeps working for
single-platform bots, because `start-thread` takes the only connection when `platform` is absent.

**Rollback.** Until step 8 starts, redeploy the previous Lambda: the flat parameters and old
registry entries are untouched, so it serves again immediately. After step 8, revert the merge to
`main` and each consumer's rewrite, redeploy the previous Lambda, and run `register` for each
consumer to rewrite the old registry entry. `centaur bot restore` repopulates SSM from the export
only if parameters were damaged. Approvals and aliases created in the nested layout after step 6 are
lost on rollback (re-approve them). Rollback takes about as long as the window.

**After the soak** (a week of normal use): **[HUMAN APPROVAL]** to run `centaur bot migrate --prune`,
which deletes the flat parameters and flat chat aliases, and delete the export file. The code
rejects the old forms from step 6 on, so the soak copies exist only for the rollback.

### After the cutover

Each step below is independent and has its own revert.

1. **Add a platform to a bot.** `centaur bot add <bot> --platform slack` stores the Slack token and
   signing secret nested under the existing bot. Set the Slack app's event URL to
   `<function URL>/slack/<bot>`, add `platforms: {telegram: ..., slack: ...}` to the repo's config
   (prompts need `platforms` or a map, as `centaur config check` says) and merge it so `register`
   runs. Force a cold start (deploy, or any function configuration update). Claim the Slack admin
   (`centaur admin claim <bot> --platform slack`) if none exists, and invite the bot.
   Revert: `centaur bot remove <bot> --platform slack`, revert the config.
2. **Fold an existing Slack-only bot into the main bot** (`garden-slack` into `garden`, if that pair
   exists; see [unknowns](#what-could-not-be-determined-from-the-code)).
   `centaur bot adopt garden-slack garden` copies the Slack secrets, approved and blocked entries
   and chat aliases into `garden`'s nested Slack connection, leaving `garden-slack` untouched.
   Before the move, merge or close open `centaur/garden-slack-<key>` pull requests: old Slack
   threads live under the old bot name (`bot:garden-slack:` state, `sessions/garden-slack/`), so
   they get new thread keys and no earlier transcript under `garden`, and the old branches would
   not be found. Then change the Slack app's event URL to `/slack/garden`
   (**[HUMAN ACTION]**: Slack re-verifies it; point it back to revert) and send a test message.
   After a soak, **[HUMAN APPROVAL]** to `centaur bot unbind garden-slack`, `centaur bot remove
   garden-slack` and retire its config.
3. **Adopt persistent destinations** per prompt: set the prompt's `destination` to a new name (for
   an existing chat alias, bind it instead with `/destination`), run it with `workflow_dispatch`,
   and check the topic. Revert: point `destination` back at the chat alias; delete the record with
   `centaur destination remove`.

Human steps: the cutover go decision and prune, the deploys, the Slack app edits and secrets (a Slack
app and its secrets only the maintainer can create), the admin claim in each new connection, test
messages to the live bots, and the final removal of an old bot.

## Alternatives considered

| Fork | Alternatives | Why the recommendation |
|---|---|---|
| Data model | **Nested connections under one bot** (`bots/<bot>/platforms/<p>/...`); flat layout with a platform suffix in every key (`bots/<bot>/slack-token`); keep bots single-platform and link them in a group (`garden` + `garden-slack` share a repo and config) | A group keeps every name and path and avoids data migration, but the config, persona, state history and thread keys would still be per name, `centaur bot add` would not become simpler, and "one bot" stays a convention. A flat suffix scheme mixes per-platform and per-bot keys in one directory. Nested has one rule for per-connection keys. |
| Receiver structure | **One `Chat` per connection on the shared bot prefix**; one `Chat` with several adapters | Per-connection reuses the one-adapter code unchanged (access, admin channel, ownership). A multi-adapter `Chat` needs every handler to branch on `thread.adapter.name`. |
| Destination key | **By name, per connection**; by chat (topics attached to an approved chat); by name, global | By-chat allows only one persistent topic per chat and cannot say "the same name on two platforms". A global name collides across bots, which each create their own topics. |
| Policy storage | **A `thread-meta` record**; Chat SDK thread state; the destination record | Thread state expires after 30 days, which loses ownership and policy for a monthly prompt. A destination record is the admin's, but the policy is the prompt's, and it would not cover threads that are not destinations. |

## Decisions

Accepted on 2026-11-22, as recommended, with one amendment: there is no backwards compatibility.
The maintainer approved the nested SSM layout and chose to migrate existing data and configs once
instead of keeping the old forms working. So the code never reads the flat SSM layout, a flat chat
alias, an old registry entry or the legacy top-level config keys; old config keys fail with an error
that points at `centaur config migrate`. "Configs" covers both the bots' SSM records and state-table
keys and the consumer `.centaur.yml` files. Decisions that relied on compatibility are amended below.

1. **SSM layout: nested connections** under `bots/<bot>/platforms/<platform>/`. Only the nested
   layout is read and there is no mixing; `centaur bot migrate` copies the flat layout once.
   Alternatives above.
2. **Receiver: one `Chat` per connection**, sharing `bot:<bot>:`.
3. **One state prefix per bot**, shared by connections (keeps `garden`'s history), rather than a
   prefix per connection. State keys other than `registry:<bot>` are unchanged, so they need no
   migration.
4. **Config shape: a `platforms` map only.** The legacy top-level `platform`, `respond_to` and
   `handle` are rejected, with an error naming `centaur config migrate`; there is no normalization.
5. **Prompt destination: a name or a per-platform map**, with `platforms` required when more than one
   platform is declared. The alternative, fan out to every declared platform, would make adding
   Slack change where existing prompts post. `resume` with several targets is rejected.
6. **Fan-out: one turn, one reply posted to every target**; a failed target fails the run after the
   others post; the pull request links to the first target.
7. **Destinations are named per connection** (`destinations/<name>`), with chat aliases as chat-level
   destinations. Aliases are platform-scoped (`chats/<platform>/<alias>`) for every alias; the flat
   form is migrated and then not read.
8. **Create on first use only when the connection has exactly one approved group chat.** Otherwise an
   error names the commands. A name that resolves to an alias keeps its new-thread-per-run behavior,
   so persistence is chosen by using a new name, not by a config flag.
9. **Dispatch payload unchanged**; derive the platform from `thread_id`'s prefix. The alternative is
   an explicit optional `platform` field (files listed above).
10. **Thread context policy in a `thread-meta` state record**: 90-day TTL refreshed on read, no TTL
    for destination threads. Precedence: latest in-thread command, else stored, else
    `context.default`. A thread shared by two prompts uses the latest run's policy.
11. **Missing or closed Telegram topic: reopen if closed, else recreate**, update the record and
    start with no transcript; Slack archived channels fail with the error.
12. **`/destination <name>` may replace an existing binding** (admin only, the reply says so), rather
    than refusing until it is removed.
13. **Slack binding by text (`!destination <name>`)**, not a registered slash command. Revisit if
    section 12 chooses slash commands.
14. **Merging a Slack-only bot into the main bot starts old Slack threads fresh**: no copy of state,
    sessions or branches; open pull requests are merged or closed first. `centaur bot adopt` stays
    for this (it writes only the nested layout); it is not a compatibility tool.
15. **Undeclared connections are not served**: the receiver serves the platforms in the registry
    entry. An entry without `platforms` (the old shape) serves nothing until `register` rewrites it.
16. **Section 9's open item** ("check `destination` aliases against SSM at register time"):
    **no**. With create-on-first-use a destination name can be legitimately unresolved at register;
    `register` checks only that each declared platform has a connection.
17. **Order against section 15**: ship persistent threads that use `transcript` or `resume` only
    after bounded transcript 3, because a weekly thread's transcript grows without bound. The
    earlier slices have no such dependency.

### Open after amendment

No accepted Decision became contradictory. Three things the amendment leaves open, each with a
recommendation, tracked as **[HUMAN APPROVAL]** in [TODO.md](../TODO.md#16-platforms-and-destinations):

- **The registry entry cannot be migrated by the CLI** (it lives in the state table, which the CLI
  cannot reach). Recommendation: `register` rewrites it, so re-registering every bot is a cutover
  step, and the bots stay silent from the Lambda deploy until it runs.
- **A flat chat alias whose platform cannot be inferred** (no bot's approved chats contain its chat
  ID). Recommendation: `bot migrate --dry-run` lists these; the maintainer assigns each with
  `--alias-platform <alias>=<platform>` or drops it.
- **The set of consumer repos.** Recommendation: enumerate them from `bots/*/repo` in SSM and rewrite
  each with `centaur config migrate`; a consumer not bound to any bot is out of scope.

## Implementation plan

"Lambda" slices change what is deployed with `yarn deploy-prod`; "runner" slices change the actions
and `prepare`/`finish` and are live as soon as they merge to `main`. Because data and configs have
one form, slices 1 to 8 are not independently mergeable: they are built as stacked pull requests
into the branch `platforms/cutover`, each with tests and docs, and go live together in slice 18.
Slices 9 to 17 branch from `main` after slice 18, are independently mergeable, and a runner slice
merges only after the Lambda it calls is deployed. Slices that share a file are listed and must be
serialized; the others can run in parallel.

| # | Slice | Kind | Likely files | After |
|---|---|---|---|---|
| 1 | Config schema: `platforms` map only, legacy top-level keys rejected with a pointer to `config migrate`, destination string or map, prompt `platforms`, errors; readers (`register.ts`, `prepare.ts`) take per-platform settings | Both | `src/config/schema.ts`, `src/config/index.ts`, `src/lambda/register.ts`, `src/workflows/prepare.ts`, `test/config.test.ts`, `test/helpers/config-fixtures.ts`, `docs/config.md` | none |
| 2 | Connection model and loader: nested layout only, connection view, per-connection path helpers | Lambda | `src/lambda/registry.ts`, `parameters.ts`, `access-entries.ts`, `access.ts`, `test/helpers/receiver-fixtures.ts`, `poster-fixtures.ts` | none (parallel with 1) |
| 3 | CLI connections: `bot add` onto an existing bot, `bot list`, `bot remove --platform`, `--platform` on `access` and `admin claim`, `chat list` for scoped aliases | CLI | `src/cli/commands/bot.ts`, `access.ts`, `admin.ts`, `src/cli/registry.ts`, `docs/cli.md` | 2 |
| 4 | CLI migration tools: `bot export` and `bot restore` (backup of every bot's SSM parameters and chat aliases), `bot migrate` (`--dry-run`, copy and verify, `--prune` for the flat parameters after the soak, `--alias-platform`), `config migrate` (rewrites a config file, keeping comments), and `bot adopt` (Decision 14) | CLI | `src/cli/commands/bot.ts`, new `src/cli/commands/config.ts`, `docs/cli.md` | 3 (same files), 1 for `config migrate` |
| 5 | Registry entry per platform and `register` over declared platforms; an old-shape entry serves nothing | Lambda | `src/lambda/register.ts`, `registry.ts`, `docs/poster.md` | 1, 2 |
| 6 | Receiver: one `Chat` per connection, per-platform `respond_to` | Lambda | `src/lambda/receiver.ts`, `chat.ts`, `message-handler.ts`, `test/receiver*.test.ts`, `docs/plan.md` | 2, 5 |
| 7 | Poster derives the connection from the thread ID; `start-thread` takes `platform` (optional on a single-connection bot) | Lambda | `src/lambda/poster.ts`, `registry.ts`, `docs/poster.md` | 2 (after 5, same `registry.ts`) |
| 8 | Platform-scoped chat aliases (flat form not read) and the resolution order | Lambda, CLI | `src/lambda/chat-aliases.ts`, `access-decisions.ts`, `poster.ts`, `src/cli/chat-aliases.ts`, `commands/access.ts`, docs | 2, 7 |
| 9 | `thread-meta` record: `start-thread` stores `context`, `read` returns `policy`, ownership reads it | Lambda | new `src/lambda/thread-meta.ts`, `poster.ts`, `ownership.ts`, `message-handler.ts`, `docs/poster.md`, `docs/workflows.md` | 18 |
| 10 | Runner reads the stored policy; scheduled runs pass `context` to `start-thread`: closes the thread-policy gap for every prompt | Runner | `src/workflows/prepare.ts`, `finish.ts`, `transcript.ts`, `docs/workflows.md`, `docs/plan.md` | 9 deployed |
| 11 | Destination records, resolution order, create on first use, recreate (Telegram), `resolve-destination`, IAM | Lambda | new `src/lambda/destinations.ts`, `poster.ts`, `telegram.ts`, `infra/centaur.yml`, `test/infra.test.ts`, `docs/poster.md`, `docs/deploy.md` | 8, 9, 18 |
| 12 | Slack persistent thread and Slack post-into-thread | Lambda | `src/lambda/destinations.ts`, `poster.ts` | 11 |
| 13 | `/destination` and Slack `!destination` handlers | Lambda | new `src/lambda/destination-command.ts`, `admin-handlers.ts`, `chat.ts`, `message-handler.ts` | 11 |
| 14 | `centaur destination set\|list\|remove` | CLI | new `src/cli/commands/destination.ts`, `program.ts`, `docs/cli.md` | 11 (parallel with 13) |
| 15 | Multi-target scheduled turns: targets in the turn state, fan-out in `finish`, per-platform settings in `prepare` | Runner | `src/workflows/prepare.ts`, `turn-state.ts`, `finish.ts`, `cli.ts`, `docs/workflows.md`, `docs/plan.md` | 10 |
| 16 | Persistent-thread scheduled turns: history, marker and session under the destination thread, `resolve` job and concurrency template | Runner | `src/workflows/prepare.ts`, `finish.ts`, `docs/workflows.md`, the self-consumer workflow | 11, 15, bounded transcript 3 |
| 17 | Docs sweep: `onboarding.md` (add a platform, bind a topic), `plan.md` SSM layout, receiver and access sections, `config.md`, `cli.md`, `poster.md`, README; mark this doc as built | Docs | `docs/*.md`, `README.md` | all |
| 18 | Cutover: the runbook in [Migration](#migration), run once by the maintainer after a rehearsal | Human | | 1 to 8 |
| 19 | Live checks on the test bot: two platforms on one bot, a persistent topic and Slack thread, deleted and closed topic error strings | Human | | 12, 16 |

Parallel groups: {1, 2}; then {3, 5}; then {4, 6, 7}; then 8; then 18; then {9}; then {10, 11}; then
{12, 13, 14, 15}; then 16, 17, 19.
Deploy gates: (a) nothing from slices 1 to 8 reaches `main` or a deploy before the cutover go
decision and a passed rehearsal (`bot export` and `bot migrate --dry-run` against production,
`bot migrate` and a deploy-and-register against a test bot); (b) the cutover deploys the Lambda from
`platforms/cutover` before that branch merges to `main`; (c) after the cutover, each Lambda slice (9,
11, 12, 13) is deployed and checked before the runner slices that call it (10, 15, 16) merge.

## What could not be determined from the code

- Whether `garden-slack` exists, which repo it is bound to, and whether `centaur-hello` and the
  self-consumer (`bot: centaur-slack`) share bots. A repo's config names one `bot`, so folding
  `garden-slack` into `garden` also means deciding which repo answers on Slack.
- The exact Telegram Bot API error text for a deleted or closed topic, how Slack behaves when a
  thread's parent message is deleted, and whether `state.set` without a TTL never expires in
  `@blevinstein/chat-state-dynamodb`. Each needs a live check or a read of the adapter.
- Whether a Chat SDK dedupe key includes the adapter name; two `Chat` instances on one prefix rely on
  it, and one test should pin it.
