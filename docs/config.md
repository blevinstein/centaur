# Centaur config (`.centaur.yml` or `.centaur/config.yml`)

Per-consumer-repo configuration. The schema lives in `src/config/schema.ts` (zod); the receiver,
`register` operation and shared workflows all go through `parseCentaurConfig(text)` from
`src/config/`. See [plan.md](plan.md#configuration) for how the file fits into the system and
[onboarding.md](onboarding.md#adding-a-repo) for setup. MCP server design: [mcp.md](mcp.md).

## Location

The config lives in one of two places, both permanently supported:

- `.centaur.yml` at the repo root: best for a repo that needs only the config, or a few files.
- `.centaur/config.yml`: best for a repo with many prompts, instructions and other files under
  `.centaur/`, so everything Centaur reads sits in one directory.

Every reader (`prepare`, `register`, the turn's `config_root` copy and `centaur config check`)
looks for both. If exactly one exists it is used. If both exist, they fail naming both files;
remove one. If neither exists, they fail naming both paths.

Paths inside the config (`persona`, `instructions`, prompt files) are relative to the repo root,
not to the config file, and the MCP policy is `.centaur/mcp-policy.cedar` at the repo root, wherever
the config lives. The register workflow's `paths` filter lists both locations.

```yaml
bot: garden
platforms:
  telegram:
    respond_to: mention
    handle: garden_helper_bot  # the bot's @username; only used with respond_to: all
  slack: {}                    # a bot may be on several platforms; settings default as below
context:
  default: transcript
  scheduled: fresh
provider: anthropic
model: sonnet
effort: medium
max_turns: 30
max_budget_usd: 1.0
allowed_tools: "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,mcp__linear__*"
mcp_servers:
  linear:
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: { secret: LINEAR_API_KEY, prefix: "Bearer " }
persona: .centaur/persona.md
instructions:               # all optional; each replaces the bundled guidance
  chat: .centaur/instructions/chat.md
prompts:
  weekly-tasks:                 # file defaults to .centaur/prompts/weekly-tasks.md
    context: transcript         # overrides context.scheduled for this prompt
    platforms: [telegram, slack]  # where a string destination applies; required with 2+ platforms
    destination: household      # a name on each listed platform (required)
  frost-alert:
    destination:                # or one name per platform; no `platforms` key then
      telegram: household
      slack: garden-alerts
```

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `bot` | yes | | Bot alias; secrets live under `/centaur/bots/<bot>/` in SSM. |
| `platforms` | yes | | The platforms the repo expects the bot to be on: a map from `telegram` or `slack` to per-platform settings, at least one. See [Platforms](#platforms). |
| `context.default` | no | `transcript` | Policy for conversational threads: `fresh`, `transcript` or `resume`. |
| `context.scheduled` | no | `fresh` | Policy for threads started by a scheduled prompt. |
| `context.transcript_max_percent` | no | `25` | Planned, not implemented. Share of the model's context window the earlier transcript may fill, an integer from 1 to 100. See [Context](#context). |
| `context.window_tokens` | no | | Planned, not implemented. The model's context window in tokens, overriding the lookup. |
| `provider` | yes | | API provider: `anthropic` or `openrouter`. Each maps to a base URL and API key secret name in `src/config/providers.ts` (`anthropic` uses the default endpoint); add a provider by adding an entry there. |
| `model` | yes | | Model passed to the agent (`--model`). Always set explicitly; the CLI default is never relied on. |
| `effort` | no | | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` (`--effort`); unset uses the CLI's default. |
| `max_turns` | no | `30` | Agentic turn cap per run (`--max-turns`), an integer from 1 to 200. |
| `max_budget_usd` | no | | Spend cap per run (`--max-budget-usd`), above 0 and at most 1000. A run that hits it may end without a structured reply, so the turn fails and is retried with the next message. |
| `allowed_tools` | yes | | Tool allowlist: a comma-separated string or a YAML list. |
| `mcp_servers` | no | `{}` | Additional MCP servers by name (see below). |
| `persona` | no | `.centaur/persona.md` | Repo-relative path to the persona file. |
| `instructions` | no | `{}` | Repo-relative paths to files replacing the bundled behavior guidance in the agent prompt: `chat` (replying in a thread), `comment` (revising a pull request after review comments) and `silence` (when to stay quiet under `respond_to: all`) and `chat_context` (how to use the chat context tools, included only with `chat_context.scope: chat`). Defaults are `src/workflows/instructions/*.md`. A configured file that is missing or empty fails the turn. The output-format, `ignore` and untrusted-input wording is appended by the workflow and cannot be overridden. |
| `pull_requests` | no | `{}` | Which pull request the agent may target and whose comments it answers, a strict block. `comment_authors` (default `[OWNER, MEMBER, COLLABORATOR]`) lists the GitHub `author_association` values whose comments can trigger a turn and appear in its prompt. `comment_new` (default `true`) lets a pull request comment turn set `pr_action: new` to open a separate pull request instead of updating the original. `existing` (`bot`, the default, or `off`) lets chat and scheduled turns set `existing_pr_number` to land changes on an open pull request of the same bot, from any of its threads. A disabled switch removes the field from the agent's output schema and prompt. See [Pull request targets](#pull-request-targets). |
| `chat_context` | no | `{}` | Strict block for the [chat context tools](chat-context.md). `scope` is `thread` (the default: no tools, nothing outside the dispatched thread) or `chat` (the tools may read other threads of the dispatched thread's own chat, never another chat). `max_threads` (default `20`, 1 to 50) and `max_messages` (default `50`, 1 to 200) cap what one tool call returns. With `scope: chat`, `prepare` starts the built-in `centaur-chat` server for turns that have a dispatched thread (chat replies and pull request comments; not scheduled or `/new` seed turns), adds `mcp__centaur-chat__*` to the allowed tools for that turn and adds the guidance block; a configured `mcp_servers.centaur-chat` is rejected. |
| `prompts` | no | `{}` | Scheduled prompts by name (see below). |

Each prompt takes `file` (default `.centaur/prompts/<name>.md`), `context` (default
`context.scheduled`), `destination` (required) and `platforms`; see [Prompts](#prompts). The
parser only checks the shape; a destination name is resolved when the run starts (see
[Access](#access)).

## Platforms

`platforms` maps each platform the bot is on to its settings, a strict object with two optional keys:

| Key | Default | Meaning |
|---|---|---|
| `respond_to` | `mention` | Which messages the bot answers: `mention` (mentions, DMs, topics it created, and on Slack the rest of a thread it was mentioned in) or `all` (every message from an approved sender in any approved chat of the bot on that platform). See [plan.md](plan.md#routing-in-a-shared-telegram-group). |
| `handle` | | The bot's username on that platform without `@`. With `respond_to: all` the prompt tells the agent people mention it as `@<handle>`. The workflow cannot learn it cheaply from the bot's identity, so it is configured. |

Everything else (`context`, `provider`, `model`, tools, MCP, `pull_requests`) is bot-wide. `register`
fails if a declared platform has no secrets in SSM. A turn reads the settings of the platform in its
thread ID's prefix (`telegram:...`, `slack:...`); a scheduled turn reads those of its target.

The top-level `platform`, `respond_to` and `handle` are not accepted. Each fails with an error that
names the replacement and points at `centaur config migrate`:

```text
platform: is not supported: declare it under `platforms: { <platform>: { respond_to, handle } }`; run `centaur config migrate` to rewrite this file
```

## MCP servers

Each `mcp_servers` entry is exactly one of two shapes; names are aliases that contain no `__` and do
not start with `github` (the action's built-in servers). Values in `headers` and `env` are a plain
string or `{ secret: NAME, prefix?: string }`, where `NAME` matches `[A-Z][A-Z0-9_]*`.

| Shape | Fields |
|---|---|
| Remote (streamable HTTP) | `url` (https), optional `headers` |
| Local (stdio) | `command`, optional `args` (strings), optional `env` |

The parser also checks `allowed_tools` against the servers: every `mcp__<name>` or `mcp__<name>__...`
entry must name a defined server (`mcp__github*` entries for the action's built-ins are ignored), and every
server needs at least one such entry. At registration and on every turn every server is also checked against the repo's
`.centaur/mcp-policy.cedar` on the default branch and the deployer's global policy, and with neither any `mcp_servers` entry fails
([Operator policy](mcp.md#operator-policy)). See [mcp.md](mcp.md) for the secrets and trust model.

## Access

The config holds no allowlist: `allow` and `chats` are validation errors that point to `centaur
access`. Access is only what the admin approves. The effective access for a bot is the platform's
admin (implicitly allowed everywhere on their platform, and never blockable) plus the chats and
users approved for that bot through an [access request](plan.md#access-requests) or `centaur access
approve`, minus anything blocked; blocked wins. Direct messages are exempt from the chat check but
not from the user check. Approvals are stored per bot in SSM, so they never appear in the repo.

Approving a chat also creates a global chat alias, `/centaur/chats/<alias>`, named after the chat's
title (see [cli.md](cli.md)). A
prompt's `destination` names such an alias. When the run starts, the poster resolves the alias to a
chat ID and requires that chat to be approved for the bot and not blocked; otherwise it fails with
the alias and the `centaur access approve` command that fixes it.

Names (`bot`, `destination` entries, prompt names) are lowercase
aliases matching `[a-z0-9][a-z0-9_-]*`, the same pattern the CLI enforces; real IDs never appear in the repo. Paths must be relative
and stay inside the repo (no leading `/`, no `..`). Unknown keys are errors.

`/new` starts its thread in the chat the command came from (a DM stays in that DM), so it needs no
configured destination. Replies go to the originating thread.

## Responding to all messages

With `respond_to: all` on a platform, every message from an approved sender in an approved chat (or a DM)
starts a turn, and the agent decides whether to answer: its structured output is either `reply` or
`ignore: true`, and an ignored turn posts nothing but still advances the last-processed marker and
saves the session. The prompt tells the agent the messages were not necessarily addressed to it
and that it should reply to mentions. Messages from bots, including the bot itself, are never
dispatched. Every non-ignored turn still costs a model run, so use it in small private chats.
Scheduled prompts always post.

## Context

> **Status: planned, not implemented.** The keys below are not in the schema yet; today the whole
> stored transcript is sent.

```yaml
context:
  default: transcript
  transcript_max_percent: 25   # earlier messages fill at most 25% of the window
  window_tokens: 200000        # optional; otherwise looked up from the model
```

`transcript_max_percent` bounds the earlier messages of a `transcript` turn (and of a `resume` turn
that falls back to the transcript), newest first. 25 leaves most of the window for the persona, the
instructions, the repo, tool results and the agent's own work. Pending messages are always shown,
and one oversized message is truncated. Messages beyond the bound are omitted with a note, and the
agent reads them through the [chat context tools](chat-context.md). The window comes from
`window_tokens`, else polytokenizer's context limits for the model, else 200,000 tokens. See
[workflows.md](workflows.md#transcript-budget-planned) for the mechanics.

## Tuning cost

Each turn is one `claude` run, so cost scales with model price, reasoning, and number of tool turns.

| Field | Mechanism |
|---|---|
| `model` | A smaller model costs less per token. |
| `effort` | Lower effort spends fewer reasoning tokens per turn. |
| `max_turns` | Bounds the number of tool-use round trips, and so the worst-case run. |
| `max_budget_usd` | Hard cap on spend per run. |
| `allowed_tools` | Fewer tools mean a smaller prompt and fewer ways to wander. |
| `context.default` | `fresh` sends only pending messages; `transcript` re-sends the thread each turn; `resume` reuses a saved session. |
| `mcp_servers` | Each server adds its tool list to every turn's prompt; allow only the tools needed (`mcp__<name>__<tool>`). |
| `platforms.<p>.respond_to` | `all` runs a turn for every message from an approved sender, even ones the agent then ignores. |

Two ideas are not built: a separate cheaper model
that only decides whether to reply (triage) would need a second agent run per message, which the
single `claude` invocation per turn cannot do; and a thinking-token budget has no CLI flag
(`--effort` is the supported control). Both are follow-ups.

## Prompts

`prompts` names the scheduled prompts a repo owns. The cron expression stays in the consumer's
caller workflow (`schedule:`), which passes the prompt name to the shared workflow. Each
entry has a required `destination`, an optional `platforms`, an optional `file` (default
`.centaur/prompts/<name>.md`) and an optional `context` policy.

`destination` is a name or a map from platform to name:

- A name applies on each platform in the prompt's `platforms`. `platforms` is required when the
  bot declares more than one platform, so adding a second platform to a config makes
  `centaur config check` point at each prompt that needs it instead of posting to a new place. With
  one declared platform, `platforms` may be omitted.
- A map (`destination: {telegram: household, slack: garden-alerts}`) names one destination per
  platform and must not be combined with `platforms`.
- Every platform used must be declared in `platforms`, and `context: resume` with more than one
  target is an error: a session belongs to one thread.

The parser resolves the file, context and targets, so consumers see every prompt with a concrete
`file`, `context` and `targets` (a list of `{ platform, destination }`). The scheduled runner
currently handles prompts with exactly one target.

## Pull request targets

`pull_requests` is a strict block (unknown keys fail the parse) with two switches and a
comment author list. Each switch adds one optional field to the agent's structured output and a
matching passage to its prompt; turned off, the field and the passage are absent.

| Key | Default | Turn | Field | Effect |
| --- | --- | --- | --- | --- |
| `comment_new` | `true` | pull request comment | `pr_action: update\|new` | `new` opens a separate pull request for the changes instead of pushing to the commented one. |
| `existing` | `bot` | chat, scheduled | `existing_pr_number` | Lands the changes on an open pull request of the same bot instead of the thread's own. `off` disables it. |

`comment_authors` is a non-empty list of `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN` and `NONE`. Pull request comment turns
ignore comments from any other association, both as triggers and as prompt input (for example
`[OWNER]` locks a repo down to its owners). It narrows who is heard; the commenter still needs
repository write access to trigger a turn. The config is read from the default branch, so a pull
request cannot loosen it. See [pr-comments.md](pr-comments.md#whose-comments-are-heard).

An invalid `existing_pr_number` is not an error: the changes go to the thread's normal pull
request. The validation rules, fallbacks and security model are in
[workflows.md](workflows.md#choosing-the-pull-request).

## Parsing

```ts
const result = parseCentaurConfig(text);
if (!result.ok) throw new Error(formatIssues(result.issues));
result.config; // CentaurConfig, with defaults applied and allowed_tools as string[]
```

Failures return `{ ok: false, issues: [{ path, message }] }` with dotted paths such as
`context.default`, `platforms.slack.respond_to` or `prompts.weekly.context` (`(root)` for document-level problems, including
invalid YAML). Parsing never throws on bad input.

`centaur config check [path]` runs this parser from the command line; see [CLI](cli.md#centaur-config-check-path).

## Design decisions

- **zod and `yaml`, no hand-rolled parsing.** The inferred type is the single source of truth
  consumed by the receiver and workflows.
- **Strict objects.** A typo like `provder:` fails registration instead of silently dropping the
  setting.
- **Normalized output.** `allowed_tools` is accepted in the plan's comma-separated form or as a
  list, and always returned as `string[]`; prompt entries have defaults resolved. Consumers never
  re-implement defaults.
- **Result, not exceptions.** `register` and the workflows need to report every issue, not just the
  first, and the two callers handle failure differently (reject registration vs fail the job).
- **Cron stays in the workflow.** GitHub Actions only honors `schedule:` in workflow files, so
  duplicating cron in the config would drift. The config only describes what a prompt is.
- **No legacy keys.** The parser accepts one schema; the old top-level `platform`, `respond_to` and
  `handle` fail with a pointer to `centaur config migrate`, so there is no normalization layer.
- **No allowlist in the repo.** Who may talk to the bot is the admin's decision, made from their
  phone, so it cannot be widened by a pull request. The repo only names where a scheduled prompt
  posts (`prompts.<name>.destination`), and that chat must still be approved.