# Research

Findings gathered November 2026. Platform details change quickly; re-verify anything marked
**validate** before depending on it.

## Requirements

1. **Two-way chat with non-technical users.** The agent must be able to reach out (proactively and
   on a schedule) and respond to messages, in both group chats and direct messages. At least one
   participant is non-technical, so the interface must be an ordinary consumer chat app with no
   accounts, tokens, or setup beyond installing the app.
2. **Agent runs where secrets live.** Each turn must run in an environment with repo checkout and
   secrets (e.g. third-party API tokens), able to edit files and open PRs. A technical maintainer reviews
   and merges PRs; chat participants never touch GitHub.
3. **Intentional context management.** The maintainer decides, per conversation type, whether the
   agent sees prior thread context, resumes a full prior session, or starts fresh.
4. **Repo-level automation.** A repo can declare "run this prompt every week" in version control
   (see the polytokenizer `quarterly-model-update.yml` workflow for the existing pattern).
5. **Low fixed cost.** No always-on compute. Pay-per-use API pricing rather than per-seat
   subscriptions.
6. **Shared across repos.** One toolkit serves many repos; each repo picks its chat platform.

## Prior attempts

- A personal MCP-enabled agent web frontend, and a self-hosted [OpenClaw](https://openclaw.ai)
  gateway on EC2 (~$27/month). Both were only usable by the maintainer; the non-technical
  participant struggled with them. Neither is still running. Lesson: the human-facing surface must
  be a plain chat app, and anything clever lives behind it.

## Hosted agent products (rejected)

| Product | Why rejected |
|---|---|
| Cursor Automations + `@Cursor` Slack bot | Schedules, Slack triggers, and thread subscriptions are built in, but follow-ups require each participant to be on the Cursor team with repo access (paid seat). Context management is opaque. Slack triggers see public channels only. |
| Claude Code in Slack | Each user must link their own Pro/Max/Ultra Claude account. |
| Claude Tag (Slack) | Requires a Claude Team or Enterprise plan. |

Both would roughly double existing subscription cost and hide the context-management decisions
this project wants to own.

## Agent runtime: `anthropics/claude-code-action@v1`

Verified against the action's `action.yml`:

- Outputs `session_id` ("can be used with `--resume` to continue this conversation"),
  `structured_output` (when `--json-schema` is passed in `claude_args`), `execution_file`,
  `branch_name`, and `conclusion`.
- Forwards `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS` from the calling step's env, plus
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. It does **not** forward `ANTHROPIC_AUTH_TOKEN`.
- Session transcripts live in `~/.claude/projects/<escaped-cwd>/<session_id>.jsonl` on the
  runner, which is discarded after each job. Resuming across runs means persisting that file
  externally and restoring it before the next run. The checkout path
  (`/home/runner/work/<repo>/<repo>`) is stable within a repo, so the escaped-cwd directory name is
  stable too.
- Persisting the session file to S3 through a GitHub OIDC role (no stored AWS keys) and restoring
  it before the action step lets `--resume <session_id>` continue the conversation. The resumed
  run keeps the same session id and appends to the same file. The restore step takes about 4 s,
  the upload about 1 s.
- `--resume` finds the session even when the file is restored under a different escaped-cwd
  directory, so the checkout path need not match, though restoring to the matching path is the
  safe default. A session id that is not found fails the run (`error_during_execution`, empty
  `session_id`) rather than starting fresh. `actions/checkout` with `path:` does not change the
  cwd. Re-verify after Claude Code CLI upgrades.
- A repo whose OIDC subject claim is immutable-format (`repo:<owner>@<id>/<repo>@<id>:...`) fails
  a trust policy written for `repo:<owner>/<repo>:*`. Check
  `gh api repos/<o>/<r>/actions/oidc/customization/sub`.
- The session file is `~/.claude/projects/<cwd with every non-alphanumeric character replaced by
  "-">/<session_id>.jsonl`, e.g. `-home-runner-work-centaur-centaur/`. The directory name was
  identical across runs, the file name equals `session_id`, and the file is about 160–190 KB after
  one turn. A `memory/` directory sits beside it.
- When `--max-turns` is hit, the action's `session_id` and `structured_output` outputs are empty
  and the job fails, though the session file is still written. Read the ID from the execution file
  (`.[0].session_id`). The structured-output call counts as a turn, so allow at least 3.
- `--json-schema` yields valid JSON with the required `reply` string, with no extra fields even
  when the prompt invites them.
- A haiku turn costs under $0.004. The model takes 1–7 s, but the action adds 17–22 s of fixed
  overhead, so a job takes about 26–36 s with 0–4 s queue time.
- `show_full_output` dumps every message, including tool results, into the job log. Keep it off.
- The action reads the event type from the webhook payload, so `GITHUB_EVENT_NAME` overrides do
  nothing. It rejects `push` events and works under `workflow_dispatch`.
- With no `prompt` on a `workflow_dispatch` run, the action exits successfully without calling
  Claude. A green job does not mean the agent ran.
- Verified via `workflow_dispatch` against the Anthropic API with `--model haiku` and
  `--json-schema`: a structured-output turn takes about 2 s over 2 turns and costs about $0.0025,
  and `structured_output` carries the required `reply` field.
- The diagnostics `apiKeySource` field only names the env var, so it can't show which backend
  served a request. Check the provider's own usage dashboard.

### OpenRouter

OpenRouter's [Claude Code integration guide](https://openrouter.ai/docs/guides/guides/claude-code-integration)
has a GitHub Action section: pass the OpenRouter key as `anthropic_api_key` and set
`ANTHROPIC_BASE_URL=https://openrouter.ai/api`. The same guide's CLI instructions say to use
`ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) and blank `ANTHROPIC_API_KEY`, which the
action can't do since it doesn't forward `ANTHROPIC_AUTH_TOKEN`. If the documented Action path
fails, `ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer <key>"` is a plausible workaround.
Verified: the plain documented Action path works. Set `ANTHROPIC_BASE_URL=https://openrouter.ai/api`
and pass the OpenRouter key as `anthropic_api_key`; no Bearer token or custom header is needed.
`ANTHROPIC_CUSTOM_HEADERS` alone is not enough (a good Bearer header with a bogus
`anthropic_api_key` fails with 401). Negative controls confirm the routing: an OpenRouter key sent
to Anthropic, an Anthropic key sent to OpenRouter, and a bogus key all fail with each provider's
own 401. A failing key retries for about 3 minutes, so set a job timeout. Latency matches the
Anthropic API; cost differences came from prompt caching.

### GitHub Actions cost and visibility

- Free plan: standard runners are free for public repos. Private repos get $12/month of compute
  (2,000 standard Linux minutes at $0.006/min). Failed runs and reruns are billed.
- Expected 30–90 s from dispatch to first agent output, so chat replies are not instant.
- **Logs and artifacts on public repos are public.** `garden` is public. Workflows there must not
  echo transcripts or prompts, must keep `show_full_output` off, and must store sessions and
  transcripts outside GitHub (S3), never as artifacts. See the open question in
  [plan.md](plan.md#open-questions).

## Messaging platforms

The Lambda-only constraint rules out anything that needs a persistent connection to receive
messages.

| | Telegram | Slack | Discord | Email (SES) |
|---|---|---|---|---|
| Setup | BotFather: token + `setWebhook` | Workspace, app (manifest), scopes, event subscription | Dev portal app, server, invite | Domain DNS, SES receipt rule |
| Cost | Free, full history | Free plan hides history after 90 days; ~$9/mo for 2 users for full history | Free | ~$0 |
| Receive via webhook | Yes, with a secret-token header | Yes, 3 s ack deadline | **No** — ordinary messages only via the Gateway websocket; HTTP covers slash commands/interactions only | Yes, SES → Lambda |
| Bot reads history | **No** Bot API for chat history | Yes | Yes | If stored |
| One identity per repo | One bot per repo, own name/avatar | One app per repo, or one app posting under custom names (`chat:write.customize`) | One app per repo | One address per repo |
| Conversation unit | Forum topic in a supergroup; reply chains | Thread | Thread | Email thread |
| Non-technical UX | Good | Feels like work | Busy, gamer-flavored | Familiar but slow |

Also considered and rejected:

- **WhatsApp Cloud API:** Meta business verification, dedicated number, paid templates for
  outbound messages outside the 24 h window, limited group support.
- **Signal, iMessage:** no official bot API; require an always-on relay (signal-cli, a Mac running
  BlueBubbles).
- **SMS (Twilio):** carrier registration, clumsy group texts, no threads.
- **Matrix, Zulip:** harder sell for non-technical users; Matrix bots typically hold a sync
  connection open.

Decision: **Telegram for household repos, Slack for personal projects**, selectable per repo.

### Telegram specifics (verified against core.telegram.org)

- "Bots can't start conversations with users. A user must either add them to a group or send them
  a message first." DMs require each person to tap Start on each bot once; groups do not.
- Bots never see messages from other bots, so per-repo bots in one group can't loop on each other.
- Privacy mode (default on) limits group visibility to commands, replies to the bot, and mentions.
  Bots added as **group admins** always receive all messages.
- `createForumTopic` in a supergroup requires the bot to be an admin with `can_manage_topics`.
- Bot API 9.3 added topics in private chats, but since Bot API 10.0 (May 2026) sending into an
  existing private-chat topic fails with "message thread not found"
  ([tdlib/telegram-bot-api#847](https://github.com/tdlib/telegram-bot-api/issues/847)). Avoid DM
  topics; use reply chains in DMs.

## Chat SDK (`vercel/chat`)

[Chat SDK](https://github.com/vercel/chat) (MIT, actively maintained) is a TypeScript framework
with one bot API and per-platform adapters, including `@chat-adapter/telegram` and
`@chat-adapter/slack`. Using it keeps platform code out of this repo and makes the platform a
per-repo configuration choice.

Relevant details from the Telegram adapter README:

- Webhook mode requires `secretToken`; polling mode exists for local development.
- Telegram has no history API, so `persistThreadHistory` (default `true`) saves incoming messages
  and the bot's own posts in the state adapter. `thread.messages` then returns earlier turns. The
  bot's replies must therefore be posted **through the SDK** to appear in that history.
- Webhook updates are deduplicated for 24 h through the state adapter; if state is unavailable the
  adapter returns 503 so Telegram retries. Durable shared state is required on serverless.
- Not supported on Telegram: slash commands (as an SDK feature), modals, listing threads.

State adapters published by the project: Redis, ioredis, Postgres, in-memory. Community: Convex,
Cloudflare Durable Objects. There is **no DynamoDB adapter**. The `StateAdapter` interface is
19 methods (key-value get/set/delete with TTL, `setIfNotExists`, list append, locks, a per-thread
queue, subscriptions), read at `vercel/chat` commit `990411e`. Redis and Postgres adapters are
449 and 661 source lines. There is no shared state-adapter conformance suite; each adapter has its
own tests, and `state-memory`'s are the best behavioral template. Everything maps to DynamoDB; the
awkward methods are `appendToList`, `enqueue`, `dequeue` and `queueDepth` (atomic trim and
counters). Decision in [plan.md](plan.md#open-questions).

The adapter in `src/dynamodb-state/` uses one pay-per-request table (`pk`/`sk`, TTL attribute
`ttl` in epoch seconds, plus `expiresAt` in ms filtered at read time). Lock, dedupe, subscription,
key-value, and `dequeue` operations are single conditional writes. `appendToList` and `enqueue`
write the entry and then trim, so a reader can briefly see more than `maxLength` entries, but the
newest entries are never lost. A 44-test suite ported from `state-memory` passes against both
`@chat-adapter/state-memory` and DynamoDB Local. `infra/centaur.yml` defines the table (retained on
stack deletion, TTL on `ttl`, generated name) and a `StateTableAccessPolicy` managed policy limited
to `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` and `Query` on the table ARN, which is every
call the adapter makes; the Lambda role attaches it. Not yet exercised on a deployed table.

`test/chat-dynamodb-state.test.ts` drives a real `Chat` (fake platform adapter) against the
adapter on DynamoDB Local and found no adapter bugs. How the core uses the interface:

- `appendToList` is called only for thread history (`msg-history:<threadId>` and, when it differs,
  `msg-history:<channelId>`) with `maxLength` 100 and `ttlMs` 7 days by default (configurable
  through `history.thread`). It runs before locking, so it is safe under `concurrent`. Each append
  refreshes the list-wide expiry; trimming keeps the newest entries.
- Dedupe is `setIfNotExists("dedupe:<adapter>:<messageId>", true, 10 min)`; thread state is
  `set("thread-state:<threadId>", ..., 30 days)`. Both land as `kv:` items with `expiresAt`/`ttl`.
  A scope-aware platform adapter (`getConcurrencyScope`) wraps thread and dedupe keys in
  `concurrency:[adapter,scope,key]`, which is still a valid partition key.
- `drop` and `queue` take `acquireLock(threadId, 30 s)`, heartbeat with `extendLock`, and release
  with the token; no lock items remain afterwards. `concurrent` takes no locks and never touches the
  queue.
- `queue` calls `queueDepth`, then `enqueue(threadId, {message, enqueuedAt, expiresAt}, maxQueueSize)`
  with `expiresAt` 90 s ahead by default; overflow drops the oldest. Draining calls `dequeue` until
  `null`, discards entries whose `expiresAt` has passed (the core checks, the adapter does not), and
  dispatches the newest with the earlier ones as `skipped`. `queueDepth` therefore counts expired
  entries until they are drained or DynamoDB TTL removes them, the same as `state-memory`.
- Two bots sharing one table through different `keyPrefix` values stay isolated for dedupe,
  subscriptions and history, and every item's partition key carries the prefix.

The SDK's webhook handlers take a web `Request` and return a `Response`. Lambda function URLs
deliver a different event shape, so the receiver needs a small request/response conversion, and
any work after the response must instead finish before returning, because Lambda freezes the
process once the handler returns. The receiver does this by awaiting the SDK's `waitUntil` tasks
before returning. Both the Telegram and Slack adapters answer an unsigned webhook with 401, which
the receiver's router test checks without network access.

## Sources

- claude-code-action `action.yml`: <https://github.com/anthropics/claude-code-action/blob/main/action.yml>
- OpenRouter Claude Code guide: <https://openrouter.ai/docs/guides/guides/claude-code-integration>
- Telegram bots intro and features: <https://core.telegram.org/bots>, <https://core.telegram.org/bots/features>
- Telegram Bot API: <https://core.telegram.org/bots/api>
- Discord webhook events (limited set, no `MESSAGE_CREATE`): <https://docs.discord.com/developers/events/webhook-events>
- Chat SDK: <https://github.com/vercel/chat>, <https://chat-sdk.dev/docs>
- Cursor Automations: <https://cursor.com/docs/cloud-agent/automations>
- Cursor Slack integration: <https://cursor.com/docs/integrations/slack>
- Claude Code in Slack: <https://code.claude.com/docs/en/slack>
