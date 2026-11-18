# `.centaur.yml`

Per-consumer-repo configuration. The schema lives in `src/config/schema.ts` (zod); the receiver,
`register` operation and shared workflows all go through `parseCentaurConfig(text)` from
`src/config/`. See [plan.md](plan.md#configuration) for how the file fits into the system and
[onboarding.md](onboarding.md#adding-a-repo) for setup.

```yaml
bot: garden
platform: telegram
chats: [household]             # chats the bot listens in; IDs in SSM at /centaur/chats/<alias>
allow: [maintainer, spouse]
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
allowed_tools: "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch"
persona: .centaur/persona.md
prompts:
  weekly-tasks:                 # file defaults to .centaur/prompts/weekly-tasks.md
    context: transcript         # overrides context.scheduled for this prompt
    destination: household      # chat for the new thread; optional with a single chat
```

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `bot` | yes | | Bot alias; secrets live under `/centaur/bots/<bot>/` in SSM. |
| `platform` | yes | | `telegram` or `slack`. |
| `chats` | if `prompts` is set or `respond_to: all` | | Non-empty list of chat aliases (no duplicates); IDs in SSM at `/centaur/chats/<alias>`. The receiver accepts group messages only from these chats. Without `chats` the bot is DM-only. |
| `allow` | yes (non-empty) | | Named users allowed to trigger turns; IDs in SSM. |
| `respond_to` | no | `mention` | Which messages the bot answers: `mention` (mentions, DMs and topics it created) or `all` (every message from an allowed sender in any of `chats`; requires `chats`). See [plan.md](plan.md#routing-in-a-shared-telegram-group). |
| `context.default` | no | `transcript` | Policy for conversational threads: `fresh`, `transcript` or `resume`. |
| `context.scheduled` | no | `fresh` | Policy for threads started by a scheduled prompt. |
| `handle` | no | | The bot's platform username without `@`. With `respond_to: all` the prompt tells the agent people mention it as `@<handle>`. The workflow cannot learn it cheaply from the bot's identity, so it is configured. |
| `provider` | yes | | API provider: `anthropic` or `openrouter`. Each maps to a base URL and API key secret name in `src/config/providers.ts` (`anthropic` uses the default endpoint); add a provider by adding an entry there. |
| `model` | yes | | Model passed to the agent (`--model`). Always set explicitly; the CLI default is never relied on. |
| `effort` | no | | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` (`--effort`); unset uses the CLI's default. |
| `max_turns` | no | `30` | Agentic turn cap per run (`--max-turns`), an integer from 1 to 200. |
| `max_budget_usd` | no | | Spend cap per run (`--max-budget-usd`), above 0 and at most 1000. A run that hits it may end without a structured reply, so the turn fails and is retried with the next message. |
| `allowed_tools` | yes | | Tool allowlist: a comma-separated string or a YAML list. |
| `persona` | no | `.centaur/persona.md` | Repo-relative path to the persona file. |
| `prompts` | no | `{}` | Scheduled prompts by name (see below). |

Each prompt takes `file` (default `.centaur/prompts/<name>.md`), `context` (default
`context.scheduled`) and `destination`: the chat alias where its scheduled run starts a thread. A
prompt's `destination` must be one of `chats`. It may be omitted when `chats` has exactly one
entry, which becomes the default; with several chats every prompt must name one.

Names (`bot`, `chats` and `destination` entries, `allow` entries, prompt names) are lowercase
aliases matching `[a-z0-9][a-z0-9_-]*`; real IDs never appear in the repo. Paths must be relative
and stay inside the repo (no leading `/`, no `..`). Unknown keys are errors. A top-level
`destination` (the pre-`chats` form) is rejected with a message pointing to `chats`.

`/new` starts its thread in the chat the command came from (a DM stays in that DM), so it needs no
configured destination. Replies go to the originating thread.

## Responding to all messages

With `respond_to: all`, every message from an allowed sender in any of the `chats` (or a DM)
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
| `respond_to` | `all` runs a turn for every message from an allowed sender, even ones the agent then ignores. |

Two ideas are not built: a separate cheaper model
that only decides whether to reply (triage) would need a second agent run per message, which the
single `claude` invocation per turn cannot do; and a thinking-token budget has no CLI flag
(`--effort` is the supported control). Both are follow-ups.

## Prompts

`prompts` names the scheduled prompts a repo owns. The cron expression stays in the consumer's
caller workflow (`schedule:`), which passes the prompt name or file to the shared workflow. Each
entry has an optional `file` (default `.centaur/prompts/<name>.md`) and an optional `context`
policy. The parser resolves both, so consumers see every prompt with a concrete `file` and
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

## Design decisions

- **zod and `yaml`, no hand-rolled parsing.** The inferred type is the single source of truth
  consumed by the receiver and workflows.
- **Strict objects.** A typo like `alow:` fails registration instead of silently dropping the
  allowlist.
- **Normalized output.** `allowed_tools` is accepted in the plan's comma-separated form or as a
  list, and always returned as `string[]`; prompt entries have defaults resolved. Consumers never
  re-implement defaults.
- **Result, not exceptions.** `register` and the workflows need to report every issue, not just the
  first, and the two callers handle failure differently (reject registration vs fail the job).
- **Cron stays in the workflow.** GitHub Actions only honors `schedule:` in workflow files, so
  duplicating cron in `.centaur.yml` would drift. The config only describes what a prompt is.
- **`chats` is optional** so a DM-only bot needs no named chat, but is required once any scheduled
  prompt exists or `respond_to` is `all`. The allowlist (`chats`) and the posting target
  (`prompts.<name>.destination`) are separate, so a bot can listen in several chats and post each
  prompt to one of them.
