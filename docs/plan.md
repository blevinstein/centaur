# Plan

Design of the system as built. The config and file snippets here are examples; the reference
pages ([config](config.md), [cli](cli.md), [poster](poster.md), [workflows](workflows.md)) are
authoritative for fields, flags and operations.
Responding to pull request comments is designed in [pr-comments.md](pr-comments.md). Several
platforms per bot and persistent topic destinations are designed (accepted, not built) in
[platforms-and-destinations.md](platforms-and-destinations.md).

## Architecture

```
  Telegram / Slack
        │  webhook (one path per bot)
        ▼
┌──────────────────────────┐      ┌───────────────────────────┐
│ receiver Lambda          │◄────►│ state (Chat SDK adapter)  │
│ (function URL, Chat SDK) │      │ dedupe, locks, transcripts│
└──────────┬───────────────┘      │ thread metadata           │
           │ repository_dispatch  └───────────────────────────┘
           ▼
┌──────────────────────────┐      ┌───────────────────────────┐
│ consumer repo workflow   │◄────►│ S3: Claude session files  │
│ (composes centaur        │ OIDC │ (resume policy only)      │
│  actions)                │      └───────────────────────────┘
│  claude-code-action      │
└──────────┬───────────────┘
           │ lambda:Invoke via GitHub OIDC role
           ▼
┌──────────────────────────┐
│ poster Lambda (Chat SDK) │ ── posts reply into the thread, recorded in state
└──────────────────────────┘
```

The poster can be the same function as the receiver with a different entry point. It's split out
in the diagram because it's invoked over IAM, not a public URL.

## Components

### Receiver Lambda

- Node.js on Lambda with a public **function URL**. No API Gateway or ALB needed.
- One Chat SDK `Chat` instance per connection (a bot's presence on one platform), built from that
  connection's SSM secrets at cold start, so each webhook is verified with its own connection's
  secret and handled with its own access lists, admin, `respond_to`, ownership rules, reactions and
  slash commands. The connections of a bot share the state `keyPrefix` `bot:<bot>:` (partition keys
  look like `bot:<bot>:#kv#<key>`), which keeps the bot's history and markers, and each connection
  connects its own adapter once. The prefix is collision-free: the SDK builds its dedupe key as
  `dedupe:<adapter name>:<message id>`, and thread, channel and message IDs, subscriptions, locks and
  thread state carry the adapter prefix, so the same raw numeric ID on Telegram and Slack never
  meets. The bot's access-request store is shared, but a decision applies only to a request raised on
  its own platform. Bots do not share a prefix, because Telegram message IDs are shared across bots
  in a group. A connection that fails to start is logged (bot and platform only) and not served;
  the others keep serving, and startup fails only when no connection starts. `concurrency` is
  `concurrent`, because the default `drop` strategy loses messages that arrive close together.
  The webhook path selects the connection: `/telegram/<bot>`, `/slack/<bot>`.
- The registry entry `{ platforms: { <platform>: { respond_to, handle? } } }` for each bot is stored
  in state under `registry:<bot>` (written by `register`); the bound repo is in SSM at
  `bots/<bot>/repo`. A connection whose platform the entry does not list (no entry, or the old
  `{respond_to}` shape) is not served. Access does not come from the entry: it is the admin plus the
  chats and users approved for the bot in SSM (see [Access requests](#access-requests)). Any other field in a stored entry is ignored.
- On a message:
  1. Adapter verifies the request (Telegram secret token, Slack signing secret) and deduplicates.
  2. Decide whether this bot owns the message (see [Routing in a shared Telegram
     group](#routing-in-a-shared-telegram-group)); ignore it if not. This comes first so that in a
     shared group only the owning bot ever replies to a stranger.
  3. Reject blocked chats and users silently, then group chats outside the bot's approved chats
     (DMs are exempt) and senders outside its approved users (the admin counts as approved); see [Security](#security). An addressed message from an unknown
     chat or user becomes an [access request](#access-requests) when an admin is configured.
     Otherwise unknown chats are ignored and unknown senders get a refusal; only IDs are logged.
  4. Persist the message (the SDK's `persistThreadHistory` does this) and add a 👀 reaction, which
     the workflow removes when the turn finishes. A failed reaction is logged and does not block
     the dispatch.
  5. Send a `repository_dispatch` of type `centaur-message` to the bot's repo with payload
     `{bot, thread_id, thread_key, message_id}`. The message text stays out of GitHub so it never lands in
     public logs.
- Must finish before returning: Lambda freezes after the response, so no post-response work.
  Dispatching to GitHub is a single fast API call.
- Secrets (bot tokens, webhook secrets, GitHub credential) in SSM Parameter Store or Secrets
  Manager.

### Poster Lambda

Invoked by the workflow (`aws lambda invoke`, using a role assumed via GitHub OIDC; no stored AWS
keys). Operations: `post` (bot, thread ID, text), `start-thread` (a `destination` name, with an optional `thread` of `new` or `persistent`, or the
originating thread, with an optional title), `resolve-destination`, `read`, `unreact`, `register`, and
`link-pull-request`, `resolve-pull-request` and `get-mcp-policy` (the global MCP policy bundled with
the Lambda, or null). Posting
through the SDK means the bot's own messages are recorded in state, so the transcript stays
complete. Also exposes a read operation that returns a thread's transcript, so workflows never
need direct access to the state store, an `unreact` operation that clears the 👀 reactions when a
turn is done, and the `register` operation (see
[Registration](#registration)).

### Shared actions (`centaur/.github/actions/`)

One agent turn:

1. Check out the consumer repo; read its config (`.centaur.yml` or `.centaur/config.yml`).
2. Assemble context according to the thread's [context policy](#context-management).
3. Run `claude-code-action` with the consumer repo's tool allowlist and a `--json-schema` that
   requires `reply` (text for chat) and optionally `new_thread_title`, `pr_title` and `pr_body`.
   When the bot's `respond_to` is `all`, `reply` becomes optional and the agent may instead return
   `ignore: true` to stay silent. Model, effort, turn and budget limits come from the config
   (see [config](config.md)).
4. Invoke the poster with `structured_output.reply`, unless the agent ignored the messages (the
   marker still advances and the session is still saved; an opened pull request is still linked).
   Then remove the 👀 reactions from the processed messages, also after a failure notice.
5. If files changed, open a PR (`peter-evans/create-pull-request`) titled and
   described from the agent's `pr_title` and `pr_body`, and include the link in the chat reply.
   Agents never push to the default branch.
6. Save the session file to S3 when the policy is `resume`.

`concurrency: centaur-<bot>-<thread key>` serializes turns per thread (the key is a short hash, so
the chat and topic IDs stay out of the group name and the PR branch). GitHub keeps only the newest pending
run per concurrency group, so each turn processes **all** unprocessed messages since the thread's
last-processed marker, not just the message that triggered it.

### Consumer repo workflow (in each repo, a few lines)

Each consumer has one workflow per concern: `register` (on pushes touching `.centaur.yml` or `.centaur/config.yml` and on
manual dispatch), `message` (on `repository_dispatch` of type `centaur-message`) and one per
scheduled prompt. Each composes the `setup-runtime`, `register`, `turn` and `notify-failure`
actions. The full files are in [workflows.md](workflows.md#consumer-workflows). A scheduled
prompt's workflow also has `workflow_dispatch`, which doubles as a setup check.

A scheduled run starts a **new thread** (a new Telegram topic, or a new top-level Slack message)
in the prompt's `destination` chat (a destination that must hold a chat approved for the bot) with a `fresh` context, and replies to it continue as normal conversation. A prompt whose `destination` map has several entries runs one agent turn and posts its reply to every target, each in its own new thread.

### Configuration

This repo contains no deployment-specific configuration, so it can be public and reused by
anyone. Configuration lives in three places:

| What | Where | Example |
|---|---|---|
| Bot identity, platform, routing, and agent behavior | Each consumer repo's config (`.centaur.yml` or `.centaur/config.yml`) | `bot: garden`, `platforms: {telegram: {}}` |
| Secrets, personal identifiers and access | SSM Parameter Store, managed with a CLI in this repo | Bot tokens, webhook secrets, the admin, approved and blocked chats and users, destinations |
| Deployment parameters | CloudFormation parameter overrides, kept in the deployer's own private infra repo | GitHub owner for the OIDC trust policy, stack name |

```yaml
# <repo>/.centaur.yml
bot: garden                     # secrets live under /centaur/bots/garden/ in SSM
platforms:
  telegram:                      # telegram and/or slack
    respond_to: mention         # mention | all
context:
  default: transcript           # fresh | transcript | resume
  scheduled: fresh
provider: anthropic            # anthropic | openrouter
model: sonnet
allowed_tools: "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch"
persona: .centaur/persona.md    # tone, audience, what to ask humans for
prompts:
  weekly-tasks:
    destination: household      # destination name; the chat must be approved for the bot
```

The remaining fields (per-platform `handle`, per-platform prompt `destination`, `effort`, `max_turns`, `max_budget_usd`, per-prompt `file` and
`context`) are in [config.md](config.md).

Names in the config are destination names; the real IDs never appear in any repo, so a public consumer
repo reveals only names. The file carries no allowlist (`allow` and `chats` are validation
errors); who may talk to the bot is decided only by the admin.

#### Registration

The receiver has to map an incoming webhook to a repo without reading every repo, so each repo
**registers** itself:

1. The consumer repo's caller workflow has a `register` job that runs on pushes to the default
   branch that touch the config, and on `workflow_dispatch`.
2. It invokes the Lambda's `register` operation through the GitHub OIDC role, sending the parsed
   config and the calling repo name taken from the OIDC token's claims, not from input the
   workflow could forge.
3. The Lambda upserts the registry entry (`bot → platforms → respond_to, handle`) in the state store. For Telegram it also calls `setWebhook` with the bot's token and secret from SSM, so
   webhook setup is never a manual step.
4. Registration fails if a declared platform's secrets aren't in SSM. Creating them is the maintainer's
   explicit consent that a bot exists; registration only binds it to a repo. A bot already bound
   to a different repo can't be claimed without first unbinding it with the CLI. The first binding
   is a create-only `PutParameter` (`Overwrite: false`), so of two repos racing for an unbound bot
   exactly one wins and the other is refused as a non-owner.

The OIDC role's trust policy is limited to `repo:<owner>/*`, with the owner supplied as a stack
parameter.

## Context management

Each thread has a context policy.

| Policy | Agent sees | Stored state | Use for |
|---|---|---|---|
| `fresh` | Repo, persona, and the triggering message(s) only | None | Scheduled pings, one-off questions |
| `transcript` | Above plus the thread's chat messages, rendered into the prompt | Chat SDK history (already persisted) | Default for conversations; cheap and easy to inspect |
| `resume` | The full prior Claude session, including tool calls and results | Session `.jsonl` in S3, keyed by thread | Multi-turn work where earlier tool results matter (e.g. building a plan over several replies) |

- Defaults come from the config (`context.default`, and `context.scheduled` or the prompt's
  own `context` for scheduled runs).
- In-chat overrides: `/new` (start a new thread), `/resume` and `/transcript` (switch the
  current thread's policy). Telegram slash commands aren't an SDK feature, so these are parsed
  from message text. Each turn takes the latest `/resume` or `/transcript` in the thread, else the
  thread's stored policy, else the default (see [workflows.md](workflows.md#context-policies)).
- `start-thread` stores the prompt's `context` in the thread's `thread-meta` state record
  (`thread-meta:<threadId>` under the bot's prefix; 90-day expiry refreshed on every read), and
  `read` returns it as `policy`, which `prepare` uses when no command overrides it.
- **Transcript budget.** The earlier transcript fills at most `context.transcript_max_chars`
  characters (default 100,000, about 25k tokens of English text), newest messages first. The
  rest of the window is for the persona, the instructions, the repo, tool results and the agent's
  own work. A character count needs no tokenizer and sends nothing to a vendor. Messages older
  than the cutoff are not in the prompt, and a note says how many were omitted. The agent reaches
  them, and other threads of the chat, through the [chat context tools](chat-context.md). Details
  are in [workflows.md](workflows.md#transcript-budget) and [config.md](config.md#context).
- Long `resume` sessions rely on Claude Code's automatic compaction. Add a per-thread turn or
  token cap later if costs warrant it.
- **Durable memory is the repo.** Anything that should outlive a thread (preferences, inventory,
  decisions) goes into repo files through a PR the maintainer reviews. Threads are disposable.

## Routing in a shared Telegram group

One household supergroup with topics enabled holds every household bot as an admin. Admin bots
receive **all** group messages, so each bot must decide what's addressed to it:

1. A message in a topic that the bot created belongs to that bot. The poster records this by
   setting `createdByBot: true` in the thread's state when it creates the topic, and writes a
   `thread-meta` record (below) that also marks the thread as the bot's once the 30-day thread state
   has expired.
2. A mention of `@<bot>` anywhere (e.g. in the General topic) belongs to that bot. The bot answers
   by creating a new topic for the conversation, or replies in place for quick questions.
3. On Slack, a mention that passes the access checks also marks its thread (`addressedByUser` in
   the thread's state), so later replies in that thread without a mention belong to the bot.
   Telegram never sets it, because a General-topic or non-topic message's thread ID is the whole
   chat and owning it would answer everything.
4. Everything else is ignored, including untagged top-level Slack messages.

A bot configured with `respond_to: all` replaces rules 1-4 with: every message from an approved
sender in any approved chat of the bot belongs to it, and the agent decides per turn whether to reply or
stay silent. Messages authored by bots (the Chat SDK's `author.isBot` and `author.isMe`) never
belong to any bot in this mode, so two bots in one chat can't answer each other. The checks keep
their order (ownership, chat approval, sender approval), but an unenrolled sender whose message
is not a mention or DM is dropped without a refusal (only logged with their ID, so enrollment
still works), and messages from other chats are dropped without a log. Two bots set to `all` in
the same chat would both run on every message, so give at most one bot `all` per chat.

DMs with a bot are always that bot's; DMs use reply chains, not topics (see
[research.md](research.md#telegram-specifics-verified-against-coretelegramorg)).

## Security

- **Admin-approved access per bot.** The agent holds repo write access and secrets, so only the
  admin and the users and chats the admin approved can trigger turns. The list lives in SSM, not in
  a repo, so a pull request cannot widen it. Without an admin, unknown senders get a short refusal
  (except for unaddressed messages in a `respond_to: all` chat, which are only logged) and are
  logged with their platform ID; with an admin they can start an [access
  request](#access-requests) instead (see [onboarding.md](onboarding.md)).
- **No message content in GitHub.** Dispatch payloads carry IDs only. Transcripts are fetched from
  the poster at run time and never echoed. `show_full_output` stays off.
- **Least-privilege tools.** Each repo's `allowed_tools` is an explicit allowlist.
- **Changes only via PR.** Agent output is reviewed before it becomes durable. This replaces
  a "push to main" convention for automated runs.
- **Prompt injection.** Fetched web pages (plant care guides, weather sites) are untrusted input. The allowlist
  and PR review are the backstops; avoid giving agents tools that send data elsewhere.
- **Agent-chosen pull request targets.** Chat and scheduled turns may update an open pull request
  of the same bot (`pull_requests.existing`), and comment turns may open a stacked one
  (`comment_new`). The target is re-validated from GitHub and the poster, never from the turn state
  the agent can write. Because an update pushes new commits to a possibly approved pull request,
  enable "Dismiss stale pull request approvals when new commits are pushed" where approvals are
  required. See [workflows.md](workflows.md#choosing-the-pull-request).
- **GitHub credential for dispatch.** A fine-grained PAT limited to the participating repos,
  stored in SSM at `/centaur/github/token`. `repository_dispatch` needs Contents: write, which also allows pushing, so every
  participating repo protects `main` with branch protection or rulesets. A PAT covers one
  resource owner and expires (30 days by default), so set a long expiry and a reminder; a GitHub
  App (1-hour installation tokens, multiple owners) is the upgrade path.

## Access requests

Access is only what the admin approves; the config has no allowlist. The admin admits chats and
users without touching SSM by hand: the bot asks them, and they answer from their phone.

**Flow.**

1. An addressed message (a mention, a DM or a command) arrives from a chat outside the bot's approved
   chats, or from a user outside its approved users (the admin is always approved). Unaddressed messages are still ignored
   silently, with no request and no cost.
2. If the admin has an ID for the bot's platform, the receiver creates a request and sends the admin
   a DM from the bot: request ID, kind (`chat` or `user`), the requester's display name and ID, the
   chat's title and ID, the destination name that approval will create (chat requests), and the bot's
   name. The title comes from the adapter's thread lookup (`fetchThread`); the channel lookup
   cannot be used, because Telegram's rejects the `telegram:<id>` channel ID the SDK passes. An
   unavailable title is shown as `(unknown)`. The message text is never included. The requester gets
   "I've asked my admin for access." With no admin for that platform, behavior is unchanged (chats
   ignored, users refused).
3. The admin reacts to that DM: 👍 approves, 👎 denies and blocks. Only a reaction by the admin's
   user ID on that request's DM message counts. Approval adds the chat or user and posts a short
   confirmation to the requester's thread. Approving a chat also records its destination (below). Denial is silent.
4. `/approve <id>` and `/deny <id>` in the admin DM do the same on Telegram, and are the fallback if
   reactions stop arriving. Slack has no text fallback; its commands would need a registered
   slash command, so Slack decisions are reactions only.

A chat request and a user request are separate: a new group needs its chat approved, and each
person in it still needs approval to talk to the bot (DMs only need the user).

**Destinations.** Approving a chat creates a destination scoped to the connection's platform,
`/centaur/chats/<platform>/<name>`: a JSON record `{ chatId, threadId?, bot?, context?, name, at }`
(a bare chat ID, as older approvals wrote, reads as a destination with no thread). A prompt's
`destination` names it on that platform; collisions are handled per platform and the flat
`/centaur/chats/<name>` is not read. The default name is a slug of the chat's title (lowercase,
`[a-z0-9-]`, at most 40 characters), `-2`, `-3` and so on when the name is taken, and
`chat-<last 4 digits of the ID>` when the title is unknown or has no Latin letters or digits; a
destination with no thread that already holds the chat is reused. The request stores the proposal and
the admin DM shows it; the approved entry stores the name that was recorded. The Lambda creates
destinations with SSM `Overwrite: false` and takes the next free name on a conflict, so approving
never replaces one, and its role may write only `/centaur/chats/*`. `centaur destination set` binds a name to a chat or
topic by hand and replaces a record that has no owner or the same bot as owner.

When a scheduled run starts a thread, the poster looks the prompt's name up once on the connection's
platform and requires the chat to be approved for that connection and not blocked; an unapproved or
blocked chat fails with an error naming the bot, platform and name and the `centaur access approve`
command to run. A name that holds nothing is created on first use when the connection has exactly one
approved chat, and otherwise fails naming that command. A record bound to a thread belongs to the bot
in its `bot` field; the prompt's `thread` setting decides whether a run opens a new thread or posts
into the bound one (see [poster.md](poster.md#destinations)). `/new` starts its thread in the originating thread's chat, which must be approved or a DM.

**Admin channel.** `AdminChannel` (`src/lambda/admin-channel.ts`) has two jobs: send a request to
the admin as a DM, and map an incoming reaction to a verdict. Telegram and Slack implementations use
the Chat SDK adapters; `ADMIN_CHANNELS` is keyed by platform, so another channel is one more entry.
Admin identity is global: `/centaur/admin/<platform>` holds the admin's user ID on that platform.
A bot can only reach the admin on its own platform. Telegram bots cannot open a chat with a user
who has never messaged them, so the admin must message each bot once; if the DM fails the
requester is told only "I couldn't reach my admin." and the failure is logged by ID.

#### Bootstrapping the first admin

`centaur admin claim <bot>` (run with the deployer's AWS
credentials) stores `/centaur/admin-claim/<platform>`: the bot's name, an expiry (15 minutes by
default) and the SHA-256 hash of a 192-bit random code; the code itself is only printed. On
Telegram the code is the payload of a deep link (`t.me/<bot_username>?start=<code>`), so tapping
**Start** sends `/start <code>`; on Slack the owner DMs the bot `claim <code>`. `/claim <code>` also
works on Telegram. The receiver checks this before the access checks, because the claimant is
by definition unknown. It accepts the code only in a direct message to the bot the claim names,
compares hashes with `crypto.timingSafeEqual`, and checks the expiry. On success it writes the
sender's user ID to `/centaur/admin/<platform>`, deletes the claim, and replies with a fixed
sentence. Opening the DM also lets the bot reach the admin afterwards.

Why this is safe: the code has enough entropy that guessing is infeasible, and each claim also
allows at most 5 wrong attempts (counted in the state table per claim, then the claim is deleted),
so online guessing cannot succeed; only the hash is stored, so reading SSM does not reveal a live
code; the window is short and a claim is single-use; an absent, expired, wrong-bot or non-DM
attempt (including a bare `/start`) is processed as an ordinary message, so an unknown user
tapping **Start** still creates an access request and nobody learns whether a claim exists; nothing logs
the code or hash, only the claimant's ID. Whoever can run the CLI already controls the stack, so
the claim adds no new authority. Anyone who sees the link before the owner uses it can take the
admin role, so open it right away or `--cancel` it. The admin is allowed in every bot on its
platform (the access resolver adds the ID) and cannot be blocked; `access block` refuses it and the
resolver ignores a block entry for it. A claim replaces an existing admin, so a lost account is
recovered by claiming again.

**Storage.**

| Where | Key | Content |
|---|---|---|
| State table (TTL) | `access-request:<id>` | The pending request: kind, subject, display name, thread, time. |
| State table (TTL) | `access-subject:<kind>:<id>` | One pending slot per subject. |
| State table (TTL) | `access-request-message:<message id>` | Maps the admin DM to its request. |
| State table (TTL) | `access-request-claim:<id>` | Makes a decision single-use. |
| SSM | `bots/<bot>/platforms/<platform>/approved-chats/<chatId>`, `approved-users/<userId>` | Approved subjects (JSON: name, destination name for chats, time). |
| SSM | `chats/<platform>/<name>` | A destination: a chat ID or a JSON record with an optional bound thread; created by approvals, never overwritten by approvals. |
| SSM | `bots/<bot>/platforms/<platform>/blocked/<chat\|user>/<id>` | Blocked subjects (JSON: name, time). |
| SSM | `admin/<platform>` | The admin's user ID. |
| SSM | `admin-claim/<platform>` | The pending claim: bot, expiry, code hash. |
| State table (TTL) | `admin-claim-failures:<hash>` | Wrong-code count for that claim. |

Approved and blocked entries live in SSM so the [CLI](cli.md) can list, revoke and unblock them.
Effective access is the admin plus the approved entries, minus anything blocked. Blocked wins over everything except the admin user. The receiver caches the resolved access for about 30 seconds per
instance, and drops the cache when it records a decision, so the instance that handles the
decision applies it at once and others within 30 seconds. The receiver's parameter store also
caches single-parameter reads (such as the admin's user ID) for 30 seconds, never caching missing
parameters or admin claims; the poster and `register` read live. So a change made with the CLI
(`access approve`, `revoke`, `block`, a new admin) can take up to about 30 seconds to apply.

**Limits.** One pending request per (bot, kind, subject); repeats get "My admin hasn't answered
yet." once per pending request, are then ignored silently, and never trigger a new notification. At most 10 new requests per bot per hour; beyond that requests are
dropped silently with an `info` log. Requests expire after 7 days. A blocked subject triggers no
reply, no notification and no request. Request IDs are six random characters (`node:crypto`),
case-insensitive, and checked for uniqueness when created.

**Security.** A decision needs the admin's user ID, taken from the platform's signed webhook, on the
DM message that holds the request, in a direct message. Anyone else's reaction is ignored and
logged by ID. Requests are single-use and idempotent, so a second reaction or command changes
nothing. The Lambda role can write only the approved and blocked paths, `admin/*` (for a claim), and delete
only `admin-claim/*`. The admin DM contains
names and IDs but never message content.

## Validation

Ordered by risk; each experiment answered a question that could change the design. Results are in
[research.md](research.md) and [TODO.md](../TODO.md).

1. **Agent runtime (validated).** `claude-code-action` runs under `workflow_dispatch` on an
   `experiment/*` branch (a `workflow_dispatch` stub on `main` makes the branch's workflow
   dispatchable). Both the Anthropic API and OpenRouter work through the documented Action path
   (`anthropic_api_key` plus `ANTHROPIC_BASE_URL`), `--json-schema` yields a usable
   `structured_output`, and a session file restored from S3 lets `--resume` continue the
   conversation.
2. **Chat SDK on Lambda (validated).** The receiver runs on the deployed stack with a Telegram bot
   and the DynamoDB state adapter; dedupe, history and thread state persist across invocations.
   The Lambda connects each state adapter it creates (`connectState`; the poster caches one per key prefix), because
   Chat SDK state adapters reject every call before `connect()`.
3. **End-to-end Telegram (validated).** Message, dispatch, turn and reply in a test supergroup with
   topics took about 47 s from dispatch to posted reply. Bot-created topics, replies in them
   without a mention, `respond_to: all` and the 👀 reaction work. Routing with two bots in one
   group is not yet verified.
4. **Scheduled outreach (validated).** A scheduled prompt starts a new topic, and a human reply
   continues it under the `transcript` policy.
5. **Slack (not validated).** One personal-project repo on Slack, using an app manifest to reduce
   setup; no manifest exists yet.

The first real use is a weekly `garden` check-in: each Saturday, post the
week's tasks from the season's `SCHEDULE.md`, take reports in the topic ("the tomatoes have
yellow leaves", "beds 3 and 4 are mulched"), then open a PR updating the care, pest, and schedule
files.

## Decisions and open questions

Open items are tracked in [TODO.md](../TODO.md#10-decisions) and its backlog.

1. **State backend (decided).** A DynamoDB `StateAdapter` (19 methods, pay-per-request, stays in
   AWS), provided by the published `@blevinstein/chat-state-dynamodb` package (an adapter we wrote was
   declined upstream). Chosen for cost over hosted Postgres (Neon with `@chat-adapter/state-pg`),
   the fallback. Hosted
   Redis (Upstash) is the other fallback. Leaving the Chat SDK on its in-memory adapter is
   **not viable**: it would lose dedupe and history across Lambda instances.
2. **Where turns execute for public repos (decided).** Turns run in each consumer repo's own
   Actions, so a public repo's logs are public. That is acceptable for low-sensitivity repos such
   as `garden`, provided credentials are never exposed and message content stays out of logs.
   Sensitive repos stay private.
3. **One Slack app per repo vs one app with per-message names.** Decided: one app per repo, which
   mirrors the Telegram model.
4. **Progress messages mid-turn (not built).** A turn posts once at the end. A poster MCP tool
   would let the agent ask a question or post progress during a long turn.
5. **Agent-scheduled follow-ups (not built)** ("remind us Thursday if the beds aren't mulched").
   Likely EventBridge Scheduler one-off schedules that dispatch a turn.
6. **Infra placement (decided).** This repo ships a standalone CloudFormation template that imports
   nothing, so others can deploy it. Each deployer runs it from their own private infra repo,
   which holds the parameter overrides. A function URL is enough unless a custom domain on an
   existing ALB is wanted.

## SSM parameter layout

The `centaur` CLI owns these parameters (all under `/centaur/`). Secrets are `SecureString`;
IDs and names are plain `String`.

| Parameter | Type | Written by |
|---|---|---|
| `bots/<bot>/repo` | String | `register` operation; cleared by `centaur bot unbind` |
| `bots/<bot>/platforms/<platform>/token` | SecureString | `centaur bot add` |
| `bots/<bot>/platforms/<platform>/webhook-secret` | SecureString | `centaur bot add` (Telegram; generated) |
| `bots/<bot>/platforms/<platform>/signing-secret` | SecureString | `centaur bot add` (Slack; supplied) |
| `bots/<bot>/platforms/<platform>/approved-chats/<chatId>`, `approved-users/<userId>` | String (JSON) | access request approval; `centaur access approve` |
| `bots/<bot>/platforms/<platform>/blocked/<chat\|user>/<id>` | String (JSON) | access request denial; `centaur access block` |
| `admin/<platform>` | String | `centaur admin set`; a successful admin claim |
| `admin-claim/<platform>` | String (JSON) | `centaur admin claim`; deleted on use, failure limit or `--cancel` |
| `chats/<platform>/<name>` | String (a chat ID or JSON) | access request approval; `centaur access approve`; binding a thread in `start-thread` |
| `github/token` | SecureString | `centaur github-token set` |

A connection is a bot's presence on one platform, addressed by the base path
`bots/<bot>/platforms/<platform>`; every per-connection key hangs off it (`src/lambda/connection-paths.ts`
is the only place that builds these paths). The loader (`loadBots` in `src/lambda/registry.ts`)
reads only this nested layout and returns one `Bot` per connection: `name`, `platform`, `repo`,
`token`, `webhookSecret`. A bot without a complete connection (token and webhook or signing secret)
serves nothing, and the receiver logs one warning per bot per container.

`bots/<bot>/repo` is the bot's binding: the `owner/repo` that registered it. `register` must
refuse to overwrite it with a different repo, and `centaur bot remove` refuses while it is set.
The binding lives in SSM, next to the secrets that must exist before registration, so the CLI
needs no access to the state table.

`centaur bot add` reads each secret from `CENTAUR_BOT_<NAME>` (e.g. `CENTAUR_BOT_TOKEN`,
`CENTAUR_BOT_SIGNING_SECRET`), else from stdin lines in order when piped, else from a hidden
prompt. Secrets are never accepted as flags and never printed.
