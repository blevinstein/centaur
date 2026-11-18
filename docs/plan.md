# Plan

Design for the first version. Sketches of config and file formats are illustrative; names will
settle during implementation.

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
│ (calls centaur reusable  │ OIDC │ (resume policy only)      │
│  workflow)               │      └───────────────────────────┘
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
- One Chat SDK `Chat` instance per registered bot, built from SSM secrets at cold start. Adapter
  names are fixed and Telegram message IDs are shared across bots in a group, so each bot's `Chat`
  uses its own state `keyPrefix` (`bot:<bot>:`) to keep dedupe keys apart. `concurrency` is
  `concurrent`, because the default `drop` strategy loses messages that arrive close together.
  The webhook path selects the bot: `/telegram/<bot>`, `/slack/<bot>`.
- The registry entry `{allow, chats, respond_to}` for each bot is stored in state under
  `registry:<bot>` (written by `register`); the bound repo is in SSM at `bots/<bot>/repo`. With no
  entry, nobody is allowed; an entry without `respond_to` means `mention`. An entry written before
  `chats` existed has a single `destination`, which is read as a one-item `chats` list.
- On a message:
  1. Adapter verifies the request (Telegram secret token, Slack signing secret) and deduplicates.
  2. Decide whether this bot owns the message (see [Routing in a shared Telegram
     group](#routing-in-a-shared-telegram-group)); ignore it if not. This comes first so that in a
     shared group only the owning bot ever replies to a stranger.
  3. Reject blocked chats and users silently, then group chats outside the bot's allowed chats
     (the repo's `chats` plus approved chats; DMs are exempt) and senders outside its allowed users
     (`allow` plus approved users); see [Security](#security). An addressed message from an unknown
     chat or user becomes an [access request](#access-requests) when an admin is configured.
     Otherwise unknown chats are ignored and unknown senders get a refusal; only IDs are logged.
  4. Persist the message (the SDK's `persistThreadHistory` does this) and add a 👀 reaction, which
     the workflow removes when the turn finishes. A failed reaction is logged and does not block
     the dispatch.
  5. Send a `repository_dispatch` of type `centaur-message` to the bot's repo with payload
     `{bot, thread_id, message_id}`. The message text stays out of GitHub so it never lands in
     public logs.
- Must finish before returning: Lambda freezes after the response, so no post-response work.
  Dispatching to GitHub is a single fast API call.
- Secrets (bot tokens, webhook secrets, GitHub credential) in SSM Parameter Store or Secrets
  Manager.

### Poster Lambda

Invoked by the workflow (`aws lambda invoke`, using a role assumed via GitHub OIDC; no stored AWS
keys). Inputs: bot, thread ID, reply text, optional "start a new thread" flag and title. Posting
through the SDK means the bot's own messages are recorded in state, so the transcript stays
complete. Also exposes a read operation that returns a thread's transcript, so workflows never
need direct access to the state store, an `unreact` operation that clears the 👀 reactions when a
turn is done, and the `register` operation (see
[Registration](#registration)).

### Shared workflow (`centaur/.github/workflows/agent-turn.yml`, `workflow_call`)

One agent turn:

1. Check out the consumer repo; read its `.centaur.yml`.
2. Assemble context according to the thread's [context policy](#context-management).
3. Run `claude-code-action` with the consumer repo's tool allowlist and a `--json-schema` that
   requires `reply` (text for chat) and optionally `new_thread_title`. When the bot's `respond_to`
   is `all`, `reply` becomes optional and the agent may instead return `ignore: true` to stay
   silent.
4. Invoke the poster with `structured_output.reply`, unless the agent ignored the messages (the
   marker still advances and the session is still saved; an opened pull request is still linked).
   Then remove the 👀 reactions from the processed messages, also after a failure notice.
5. If files changed, open a PR (`peter-evans/create-pull-request`, as in polytokenizer) and
   include the link in the chat reply. Agents never push to the default branch.
6. Save the session file to S3 when the policy is `resume`.

`concurrency: centaur-<thread>` serializes turns per thread. GitHub keeps only the newest pending
run per concurrency group, so each turn processes **all** unprocessed messages since the thread's
last-processed marker, not just the message that triggered it.

### Consumer repo workflow (in each repo, a few lines)

```yaml
on:
  repository_dispatch:
    types: [centaur-message]
  schedule:
    - cron: "0 15 * * 6"   # Saturday morning: post this week's garden tasks
  push:
    branches: [main]
    paths: [.centaur.yml]
  workflow_dispatch:

jobs:
  register:
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
    uses: <owner>/centaur/.github/workflows/register.yml@main
    secrets: inherit
  turn:
    if: github.event_name != 'push'
    uses: <owner>/centaur/.github/workflows/agent-turn.yml@main
    with:
      prompt_name: weekly-tasks
    secrets: inherit
```

A manual `workflow_dispatch` registers and also runs the scheduled prompt, which doubles as a
setup check.

A scheduled run starts a **new thread** (a new Telegram topic, or a new top-level Slack message)
in the prompt's `destination` chat (one of the bot's `chats`) with a `fresh` context, and replies to it continue as normal conversation.

### Configuration

This repo contains no deployment-specific configuration, so it can be public and reused by
anyone. Configuration lives in three places:

| What | Where | Example |
|---|---|---|
| Bot identity, platform, routing, and agent behavior | Each consumer repo's `.centaur.yml` | `bot: garden`, `platform: telegram` |
| Secrets and personal identifiers | SSM Parameter Store, managed with a CLI in this repo | Bot tokens, webhook secrets, Telegram user and chat IDs |
| Deployment parameters | CloudFormation parameter overrides, kept in the deployer's own private infra repo | GitHub owner for the OIDC trust policy, stack name |

```yaml
# <repo>/.centaur.yml
bot: garden                     # secrets live under /centaur/bots/garden/ in SSM
platform: telegram              # telegram | slack
chats: [household]              # chats the bot listens in; IDs in SSM at /centaur/chats/<alias>
allow: [maintainer, spouse]     # named users; IDs in SSM at /centaur/users/<name>/<platform>
context:
  default: transcript           # fresh | transcript | resume
  scheduled: fresh
provider: anthropic            # anthropic | openrouter
model: sonnet
allowed_tools: "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch"
respond_to: mention             # mention | all
persona: .centaur/persona.md    # tone, audience, what to ask humans for
```

Names in `.centaur.yml` are aliases; the real IDs never appear in any repo, so a public consumer
repo reveals only aliases.

#### Registration

The receiver has to map an incoming webhook to a repo without reading every repo, so each repo
**registers** itself:

1. The consumer repo's caller workflow has a `register` job that runs on pushes to the default
   branch that touch `.centaur.yml`, and on `workflow_dispatch`.
2. It invokes the Lambda's `register` operation through the GitHub OIDC role, sending the parsed
   `.centaur.yml` and the calling repo name taken from the OIDC token's claims, not from input the
   workflow could forge.
3. The Lambda upserts the registry entry (`bot → repo, platform, chats, allow`) in the state
   store. For Telegram it also calls `setWebhook` with the bot's token and secret from SSM, so
   webhook setup is never a manual step.
4. Registration fails if the bot's secrets aren't in SSM. Creating them is the maintainer's
   explicit consent that a bot exists; registration only binds it to a repo. A bot already bound
   to a different repo can't be claimed without first unbinding it with the CLI.

The OIDC role's trust policy is limited to `repo:<owner>/*`, with the owner supplied as a stack
parameter.

## Context management

Each thread has a policy, set when the thread starts and stored in thread metadata.

| Policy | Agent sees | Stored state | Use for |
|---|---|---|---|
| `fresh` | Repo, persona, and the triggering message(s) only | None | Scheduled pings, one-off questions |
| `transcript` | Above plus the thread's chat messages, rendered into the prompt | Chat SDK history (already persisted) | Default for conversations; cheap and easy to inspect |
| `resume` | The full prior Claude session, including tool calls and results | Session `.jsonl` in S3, keyed by thread | Multi-turn work where earlier tool results matter (e.g. building a plan over several replies) |

- Defaults come from `.centaur.yml`; a scheduled prompt may override.
- In-chat overrides: `/new` (start a fresh thread), `/resume` and `/transcript` (switch the
  current thread's policy). Telegram slash commands aren't an SDK feature, so these are parsed
  from message text.
- Long `resume` sessions rely on Claude Code's automatic compaction. Add a per-thread turn or
  token cap later if costs warrant it.
- **Durable memory is the repo.** Anything that should outlive a thread (preferences, inventory,
  decisions) goes into repo files through a PR the maintainer reviews. Threads are disposable.

## Routing in a shared Telegram group

One household supergroup with topics enabled holds every household bot as an admin. Admin bots
receive **all** group messages, so each bot must decide what's addressed to it:

1. A message in a topic that the bot created belongs to that bot. The poster records this by
   setting `createdByBot: true` in the thread's state when it creates the topic.
2. A mention of `@<bot>` anywhere (e.g. in the General topic) belongs to that bot. The bot answers
   by creating a new topic for the conversation, or replies in place for quick questions.
3. Everything else is ignored.

A bot configured with `respond_to: all` replaces rules 1-3 with: every message from an allowed
sender in any of its `chats` belongs to it, and the agent decides per turn whether to reply or
stay silent. Messages authored by bots (the Chat SDK's `author.isBot` and `author.isMe`) never
belong to any bot in this mode, so two bots in one chat can't answer each other. The checks keep
their order (ownership, chat allowlist, sender allowlist), but an unenrolled sender whose message
is not a mention or DM is dropped without a refusal (only logged with their ID, so enrollment
still works), and messages from other chats are dropped without a log. Two bots set to `all` in
the same chat would both run on every message, so give at most one bot `all` per chat.

DMs with a bot are always that bot's; DMs use reply chains, not topics (see
[research.md](research.md#telegram-specifics-verified-against-coretelegramorg)).

## Security

- **Sender allowlist per bot.** The agent holds repo write access and secrets, so only known user
  IDs (and known chat IDs) can trigger turns. Without an admin, unknown senders get a short refusal
  (except for unaddressed messages in a `respond_to: all` chat, which are only logged) and are
  logged with their platform ID; with an admin they can start an [access
  request](#access-requests) instead (see [onboarding.md](onboarding.md)).
- **No message content in GitHub.** Dispatch payloads carry IDs only. Transcripts are fetched from
  the poster at run time and never echoed. `show_full_output` stays off.
- **Least-privilege tools.** Each repo's `allowed_tools` is an explicit allowlist, as in
  polytokenizer's workflow.
- **Changes only via PR.** Agent output is reviewed before it becomes durable. This replaces
  `garden`'s current "push to main" convention for automated runs.
- **Prompt injection.** Fetched web pages (plant care guides, weather sites) are untrusted input. The allowlist
  and PR review are the backstops; avoid giving agents tools that send data elsewhere.
- **GitHub credential for dispatch.** A fine-grained PAT limited to the participating repos,
  stored in SSM at `/centaur/github/token`. `repository_dispatch` needs Contents: write, which also allows pushing, so every
  participating repo protects `main` with branch protection or rulesets. A PAT covers one
  resource owner and expires (30 days by default), so set a long expiry and a reminder; a GitHub
  App (1-hour installation tokens, multiple owners) is the upgrade path.

## Access requests

The `.centaur.yml` allowlist (`chats`, `allow`) is the baseline. The maintainer can also admit new
chats and users without touching SSM by hand: the bot asks an admin, who answers from their phone.

**Flow.**

1. An addressed message (a mention, a DM or a command) arrives from a chat outside the bot's allowed
   chats, or from a user outside its allowed users. Unaddressed messages are still ignored
   silently, with no request and no cost.
2. If the admin has an ID for the bot's platform, the receiver creates a request and sends the admin
   a DM from the bot: request ID, kind (`chat` or `user`), the requester's display name and ID, the
   chat's title and ID, and the bot's name. The message text is never included. The requester gets
   "I've asked my admin for access." With no admin for that platform, behavior is unchanged (chats
   ignored, users refused).
3. The admin reacts to that DM: 👍 approves, 👎 denies and blocks. Only a reaction by the admin's
   user ID on that request's DM message counts. Approval adds the chat or user and posts a short
   confirmation to the requester's thread. Denial is silent.
4. `/approve <id>` and `/deny <id>` in the admin DM do the same on Telegram, and are the fallback if
   reactions stop arriving. Slack has no text fallback; its commands would need a registered
   slash command, so Slack decisions are reactions only.

A chat request and a user request are separate: a new group needs its chat approved, and each
person in it still needs approval to talk to the bot (DMs only need the user).

**Admin channel.** `AdminChannel` (`src/lambda/admin-channel.ts`) has two jobs: send a request to
the admin as a DM, and map an incoming reaction to a verdict. Telegram and Slack implementations use
the Chat SDK adapters; `ADMIN_CHANNELS` is keyed by platform, so another channel is one more entry.
Admin identity is global: `/centaur/admin/<platform>` holds the admin's user ID on that platform.
A bot can only reach the admin on its own platform. Telegram bots cannot open a chat with a user
who has never messaged them, so the admin must message each bot once; if the DM fails the
requester is told only "I couldn't reach my admin." and the failure is logged by ID.

**Bootstrapping the first admin.** `centaur admin claim <bot>` (run with the deployer's AWS
credentials) stores `/centaur/admin-claim/<platform>`: the bot's name, an expiry (15 minutes by
default) and the SHA-256 hash of a 192-bit random code; the code itself is only printed. On
Telegram the code is the payload of a deep link (`t.me/<bot_username>?start=<code>`), so tapping
**Start** sends `/start <code>`; on Slack the owner DMs the bot `claim <code>`. `/claim <code>` also
works on Telegram. The receiver checks this before the sender allowlist, because the claimant is
by definition unknown. It accepts the code only in a direct message to the bot the claim names,
compares hashes with `crypto.timingSafeEqual`, and checks the expiry. On success it writes the
sender's user ID to `/centaur/admin/<platform>`, deletes the claim, and replies with a fixed
sentence. Opening the DM also lets the bot reach the admin afterwards.

Why this is safe: the code has enough entropy that guessing is infeasible, and each claim also
allows at most 5 wrong attempts (counted in the state table per claim, then the claim is deleted),
so online guessing cannot succeed; only the hash is stored, so reading SSM does not reveal a live
code; the window is short and a claim is single-use; an absent, expired, wrong-bot or non-DM
attempt is treated as an ordinary message, so nobody learns whether a claim exists; nothing logs
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
| SSM | `bots/<bot>/approved-chats/<chatId>`, `approved-users/<userId>` | Approved subjects (JSON: name, time). |
| SSM | `bots/<bot>/blocked/<chat\|user>/<id>` | Blocked subjects (JSON: name, time). |
| SSM | `admin/<platform>` | The admin's user ID. |
| SSM | `admin-claim/<platform>` | The pending claim: bot, expiry, code hash. |
| State table (TTL) | `admin-claim-failures:<hash>` | Wrong-code count for that claim. |

Approved and blocked entries live in SSM so the [CLI](cli.md) can list, revoke and unblock them.
The effective allowlist is the baseline union the approved entries, minus anything blocked.
Blocked wins over everything. The receiver caches the resolved allowlist for about 30 seconds per
instance, and drops the cache when it records a decision, so the instance that handles the
decision applies it at once and others within 30 seconds.

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

## Validation plan

Ordered by risk. Each experiment answers a question that could change the design.

1. **Agent runtime.** On an `experiment/*` branch of this repo (a `workflow_dispatch` stub on
   `main` makes the branch's workflow dispatchable), run `claude-code-action` twice via
   `workflow_dispatch`:
   - through OpenRouter (documented Action path, then the custom-header workaround if needed) and
     through Anthropic directly;
   - capture `session_id`, upload the session file to S3, restore it in the second run, and confirm
     `--resume` continues the conversation;
   - confirm `--json-schema` yields a usable `structured_output`.
2. **Chat SDK on Lambda.** Deploy the receiver with one Telegram bot and the chosen state backend.
   Measure webhook-to-dispatch latency; confirm dedupe and history persistence across cold starts.
3. **End-to-end Telegram.** Message → dispatch → turn → reply, in a test supergroup with topics.
   Confirm bot-created topics, admin visibility, and the routing rules with two bots present.
4. **Scheduled outreach.** A cron run posts a new topic; a human reply continues it under the
   `transcript` policy.
5. **Slack.** One personal-project repo on Slack, using an app manifest to reduce setup.

After validation, the first real use is a weekly `garden` check-in: each Saturday, post the
week's tasks from the season's `SCHEDULE.md`, take reports in the topic ("the tomatoes have
yellow leaves", "beds 3 and 4 are mulched"), then open a PR updating the care, pest, and schedule
files.

## Open questions

1. **State backend (decided).** A DynamoDB `StateAdapter` (19 methods, pay-per-request, stays in
   AWS), written here and possibly contributed upstream. Chosen for cost over hosted Postgres
   (Neon with `@chat-adapter/state-pg`), which needs no custom code and is the fallback. Hosted
   Redis (Upstash) is the other fallback. Leaving the Chat SDK on its in-memory adapter is
   **not viable**: it would lose dedupe and history across Lambda instances.
2. **Where turns execute for public repos (decided).** Turns run in each consumer repo's own
   Actions, so a public repo's logs are public. That is acceptable for low-sensitivity repos such
   as `garden`, provided credentials are never exposed and message content stays out of logs.
   Sensitive repos stay private.
3. **One Slack app per repo vs one app with per-message names.** Per-repo apps mirror the Telegram
   model; a single app is less setup.
4. **Progress messages mid-turn.** V1 posts once at the end. Later: a poster MCP tool so the agent
   can ask a question or post progress during a long turn.
5. **Agent-scheduled follow-ups** ("remind us Thursday if the beds aren't mulched"). Likely
   EventBridge Scheduler one-off schedules that dispatch a turn; out of scope for v1.
6. **Infra placement.** This repo ships a standalone CloudFormation template that imports
   nothing, so others can deploy it. Each deployer runs it from their own private infra repo,
   which holds the parameter overrides. A function URL is enough unless a custom domain on an
   existing ALB is wanted.

## SSM parameter layout

The `centaur` CLI owns these parameters (all under `/centaur/`). Secrets are `SecureString`;
IDs and names are plain `String`.

| Parameter | Type | Written by |
|---|---|---|
| `bots/<bot>/platform` | String | `centaur bot add` |
| `bots/<bot>/token` | SecureString | `centaur bot add` |
| `bots/<bot>/webhook-secret` | SecureString | `centaur bot add` (Telegram; generated) |
| `bots/<bot>/signing-secret` | SecureString | `centaur bot add` (Slack; supplied) |
| `bots/<bot>/repo` | String | `register` operation; cleared by `centaur bot unbind` |
| `bots/<bot>/approved-chats/<chatId>` | String (JSON) | access request approval; `centaur access approve` |
| `bots/<bot>/approved-users/<userId>` | String (JSON) | access request approval; `centaur access approve` |
| `bots/<bot>/blocked/<chat\|user>/<id>` | String (JSON) | access request denial; `centaur access block` |
| `admin/<platform>` | String | `centaur admin set`; a successful admin claim |
| `admin-claim/<platform>` | String (JSON) | `centaur admin claim`; deleted on use, failure limit or `--cancel` |
| `users/<name>/<platform>` | String | `centaur user add` |
| `chats/<name>` | String | `centaur chat add` |
| `github/token` | SecureString | `centaur github-token set` |

`bots/<bot>/repo` is the bot's binding: the `owner/repo` that registered it. `register` must
refuse to overwrite it with a different repo, and `centaur bot remove` refuses while it is set.
The binding lives in SSM, next to the secrets that must exist before registration, so the CLI
needs no access to the state table.

`centaur bot add` reads each secret from `CENTAUR_BOT_<NAME>` (e.g. `CENTAUR_BOT_TOKEN`,
`CENTAUR_BOT_SIGNING_SECRET`), else from stdin lines in order when piped, else from a hidden
prompt. Secrets are never accepted as flags and never printed.
