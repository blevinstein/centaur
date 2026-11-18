# Shared workflows

Consumer repos call two reusable workflows in this repo's `.github/workflows/`. See
[plan.md](plan.md#shared-workflow-centaurgithubworkflowsagent-turnyml-workflow_call) for the design,
[poster.md](poster.md) for the operations they invoke, and [config.md](config.md) for
`.centaur.yml`.

| Workflow | Purpose |
|---|---|
| `register.yml` | Validates `.centaur.yml`, requests a GitHub OIDC token for the poster's audience and invokes `register`. |
| `agent-turn.yml` | One agent turn: answers a dispatched chat message, or (with `prompt_name`) starts a new thread from a scheduled prompt. |

## Caller workflow

```yaml
name: Centaur
on:
  repository_dispatch:
    types: [centaur-message]
  schedule:
    - cron: "0 15 * * 6"
  push:
    branches: [main]
    paths: [.centaur.yml]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  register:
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
    uses: <owner>/centaur/.github/workflows/register.yml@main
  message:
    if: github.event_name == 'repository_dispatch'
    uses: <owner>/centaur/.github/workflows/agent-turn.yml@main
    secrets: inherit
  scheduled:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    uses: <owner>/centaur/.github/workflows/agent-turn.yml@main
    with:
      prompt_name: weekly-tasks
    secrets: inherit
```

Pin `@main` to a tag or SHA for stability. Callers must grant the permissions shown (reusable
workflows cannot exceed the caller's): `id-token: write` for AWS and the registration token,
`contents: write` and `pull-requests: write` for the agent's pull request. Enable "Allow GitHub
Actions to create and approve pull requests" in the repo settings. Pull requests opened with the
default token do not trigger other workflows.

To run a different prompt per schedule, add one job per prompt, or pass `prompt_name` from an
expression keyed on `github.event.schedule`.

## This repo as a test consumer

This repo is its own consumer, for end-to-end testing: `.centaur.yml` binds the `centaur-test` bot
and `.github/workflows/centaur.yml` calls the shared workflows locally (`uses:
./.github/workflows/...`) with `centaur_repository` and `centaur_ref` set to the current
repository and commit. Its agent is read-only (`Read,Glob,Grep`) and it uses `respond_to: all`.

Run **Actions > Centaur > Run workflow** with `action: register` to bind the bot, or `action:
hello` to start a thread from `.centaur/prompts/hello.md`. Messages sent to the bot dispatch
`centaur-message` and are answered by the `message` job.

## Variables and secrets

Set as repository or organization **variables**:

| Variable | Value |
|---|---|
| `CENTAUR_ROLE_ARN` | `GitHubRole` output of the stack (assumed through OIDC; no AWS keys are stored). |
| `CENTAUR_AWS_REGION` | Region of the stack. |
| `CENTAUR_FUNCTION_NAME` | Name of the receiver/poster Lambda function. |
| `CENTAUR_OIDC_AUDIENCE` | The poster's `OIDC_AUDIENCE`. |
| `CENTAUR_SESSION_BUCKET` | `BucketName` output (agent turns only). |
| `ANTHROPIC_BASE_URL` | Optional; set to `https://openrouter.ai/api` to use OpenRouter. |

**Secret** `ANTHROPIC_API_KEY` (Anthropic or OpenRouter key), plus anything the agent's tools need.

## How the scripts are delivered

Both workflows check the centaur repo out into `.centaur-runtime/` at the commit of the called
workflow (`job.workflow_repository` / `job.workflow_sha`; override with the `centaur_repository` and
`centaur_ref` inputs), then `npm ci && npm run build` and run `node
.centaur-runtime/dist/workflows/cli.js <command>`. This keeps the scripts versioned with the
workflow that calls them, and all non-trivial logic in `src/workflows/` where it is unit-tested. The
centaur repo must be readable by the consumer's `GITHUB_TOKEN` (public, or granted access). The
runtime directory and `.centaur-turn/` are added to `.git/info/exclude` so they never land in a pull
request.

Commands: `register`, `prepare`, `finish`, `notify-failure`.

## Agent turn

1. `prepare` reads `.centaur.yml`, reads the thread from the poster (`read`), determines the
   unprocessed messages and the context policy, and writes the prompt to `.centaur-turn/prompt.md`.
   It outputs the `claude_args` (model, `--allowedTools`, `--json-schema` requiring `reply` (or, for `respond_to: all` threads, `reply` or `ignore: true`), persona
   via `--append-system-prompt-file`, `--resume <id>`). When there is nothing to do (everything
   processed, or only a `/resume` or `/transcript` command, which is acknowledged in the thread),
   the remaining steps are skipped.
2. `claude-code-action` runs with a constant prompt telling it to read the prompt file. If
   `allowed_tools` lacks `Read`, `Read(./.centaur-turn/**)` is added so it can.
3. `create-pull-request` opens (or updates) `centaur/<bot>-<thread>` when files changed.
4. `finish` takes the reply from the action's execution file, appends the pull request link, posts
   it (`post`, or `start-thread` for scheduled prompts and `/new`), advances the marker and saves the
   session for `resume` threads. When the agent returned `ignore: true` nothing is posted (and a
   pull request link is not delivered), but the marker and session are still saved.
5. On failure, `notify-failure` posts a generic notice with the run URL; the marker is not
   advanced, so the messages are retried on the next turn.

`concurrency: centaur-<bot>-<thread>` serializes turns per thread; scheduled runs use the run id.

### Context policies

| Policy | Prompt contains | Session |
|---|---|---|
| `fresh` | Pending messages only | none |
| `transcript` | Earlier messages in the thread, then the pending ones | none |
| `resume` | Pending messages only when a session exists; otherwise as `transcript` | `sessions/<bot>/<thread>/<session_id>.jsonl` in S3, restored to `~/.claude/projects/<escaped cwd>/` and saved back after the turn |

The thread's policy is `context.default` unless a human message in the thread used `/resume` or
`/transcript`; the latest such command wins. Scheduled prompts run with the prompt's `context` for
their own turn, which only determines whether that turn's session is saved.

### Commands

Parsed from the start of a message (`/cmd` or `/cmd@bot`, case-insensitive); any text after the
command is a normal message.

- `/new [text]`: acknowledges in the current thread, then starts a new thread seeded with `text` and
  any later pending messages (a bare `/new` opens an empty thread without running the agent).
- `/resume`, `/transcript`: switch the thread's policy for this and later turns.

### Last-processed marker

GitHub keeps only the newest pending run per concurrency group, so each turn handles every
unprocessed message. The marker is the ID of the last message the turn read, stored as
`sessions/<bot>/<thread>/last-processed` in the session bucket (IDs only, no content, and already
within the OIDC role's permissions). Pending messages are the human messages after the marker's
position in the transcript. Because the marker is the last message *read*, a message that arrives
while a turn runs stays pending even though the bot's reply lands after it. Without a marker (new
thread) or if the marker has aged out of the stored transcript, everything after the bot's latest
message is pending.

### Keeping content out of GitHub

- Message text never appears in step inputs or `env:` (which Actions prints): it travels through
  `.centaur-turn/prompt.md`, and the reply is read from the action's execution file.
- Dispatch payloads are read from the event file by the script, not through expressions.
- `show_full_output` is off, nothing is uploaded as an artifact, and the OIDC token is masked.
- Poster errors report only the error type (`register` also its message, which describes config
  problems).
- Thread IDs (chat IDs) do appear in the concurrency group name and in pull request branch names.

## Not implemented

Transcript size budgeting: `read` returns the whole stored transcript (up to 100 messages) and it
is placed in the prompt unmodified.
