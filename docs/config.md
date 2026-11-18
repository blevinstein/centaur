# `.centaur.yml`

Per-consumer-repo configuration. The schema lives in `src/config/schema.ts` (zod); the receiver,
`register` operation and shared workflows all go through `parseCentaurConfig(text)` from
`src/config/`. See [plan.md](plan.md#configuration) for how the file fits into the system and
[onboarding.md](onboarding.md#adding-a-repo) for setup. MCP server design: [mcp.md](mcp.md).

```yaml
bot: garden
platform: telegram
respond_to: mention
handle: garden_helper_bot      # the bot's @username; only used with respond_to: all
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
prompts:
  weekly-tasks:                 # file defaults to .centaur/prompts/weekly-tasks.md
    context: transcript         # overrides context.scheduled for this prompt
    destination: household      # chat alias for the new thread (required)
```

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `bot` | yes | | Bot alias; secrets live under `/centaur/bots/<bot>/` in SSM. |
| `platform` | yes | | `telegram` or `slack`. |
| `respond_to` | no | `mention` | Which messages the bot answers: `mention` (mentions, DMs and topics it created) or `all` (every message from an approved sender in any approved chat of the bot). See [plan.md](plan.md#routing-in-a-shared-telegram-group). |
| `context.default` | no | `transcript` | Policy for conversational threads: `fresh`, `transcript` or `resume`. |
| `context.scheduled` | no | `fresh` | Policy for threads started by a scheduled prompt. |
| `handle` | no | | The bot's platform username without `@`. With `respond_to: all` the prompt tells the agent people mention it as `@<handle>`. The workflow cannot learn it cheaply from the bot's identity, so it is configured. |
| `provider` | yes | | API provider: `anthropic` or `openrouter`. Each maps to a base URL and API key secret name in `src/config/providers.ts` (`anthropic` uses the default endpoint); add a provider by adding an entry there. |
| `model` | yes | | Model passed to the agent (`--model`). Always set explicitly; the CLI default is never relied on. |
| `effort` | no | | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` (`--effort`); unset uses the CLI's default. |
| `max_turns` | no | `30` | Agentic turn cap per run (`--max-turns`), an integer from 1 to 200. |
| `max_budget_usd` | no | | Spend cap per run (`--max-budget-usd`), above 0 and at most 1000. A run that hits it may end without a structured reply, so the turn fails and is retried with the next message. |
| `allowed_tools` | yes | | Tool allowlist: a comma-separated string or a YAML list. |
| `mcp_servers` | no | `{}` | Additional MCP servers by name (see below). |
| `persona` | no | `.centaur/persona.md` | Repo-relative path to the persona file. |
| `prompts` | no | `{}` | Scheduled prompts by name (see below). |

Each prompt takes `file` (default `.centaur/prompts/<name>.md`), `context` (default
`context.scheduled`) and `destination`: the chat alias where its scheduled run starts a thread. `destination` is required for
every prompt. The file only checks its shape; the alias is resolved when the run starts (see
[Access](#access)).

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
server needs at least one such entry. The file is only validated so far; see [mcp.md](mcp.md) for
the secrets, trust model and remaining steps.

## Access

`.centaur.yml` holds no allowlist: `allow` and `chats` are validation errors that point to `centaur
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

With `respond_to: all`, every message from an approved sender in an approved chat (or a DM)
starts a turn, and the agent decides whether to answer: its structured output is either `reply` or
`ignore: true`, and an ignored turn posts nothing but still advances the last-processed marker and
saves the session. The prompt tells the agent the messages were not necessarily addressed to it
and that it should reply to mentions. Messages from bots, including the bot itself, are never
dispatched. Every non-ignored turn still costs a model run, so use it in small private chats.
Scheduled prompts always post.

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
| `respond_to` | `all` runs a turn for every message from an approved sender, even ones the agent then ignores. |

Two ideas are not built: a separate cheaper model
that only decides whether to reply (triage) would need a second agent run per message, which the
single `claude` invocation per turn cannot do; and a thinking-token budget has no CLI flag
(`--effort` is the supported control). Both are follow-ups.

## Prompts

`prompts` names the scheduled prompts a repo owns. The cron expression stays in the consumer's
caller workflow (`schedule:`), which passes the prompt name to the shared workflow. Each
entry has a required `destination`, an optional `file` (default `.centaur/prompts/<name>.md`) and
an optional `context` policy. The parser resolves the file and context, so consumers see every prompt with a concrete `file` and
`context` (the prompt's own, else `context.scheduled`).

## Parsing

```ts
const result = parseCentaurConfig(text);
if (!result.ok) throw new Error(formatIssues(result.issues));
result.config; // CentaurConfig, with defaults applied and allowed_tools as string[]
```

Failures return `{ ok: false, issues: [{ path, message }] }` with dotted paths such as
`context.default` or `prompts.weekly.context` (`(root)` for document-level problems, including
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
  duplicating cron in `.centaur.yml` would drift. The config only describes what a prompt is.
- **No allowlist in the repo.** Who may talk to the bot is the admin's decision, made from their
  phone, so it cannot be widened by a pull request. The repo only names where a scheduled prompt
  posts (`prompts.<name>.destination`), and that chat must still be approved.