# Shared workflow actions

Consumer repos compose composite actions from this repo's `.github/actions/` into their own
workflows, one workflow per concern (register, chat messages, each scheduled prompt). See
[plan.md](plan.md#shared-actions-centaurgithubactions) for the design, [poster.md](poster.md) for the
operations they invoke, and [config.md](config.md) for `.centaur.yml`.

| Action | Purpose |
|---|---|
| `setup-runtime` | Builds the workflow scripts from the action's own checkout and assumes the AWS role through OIDC. Run once per job, after checking out the consumer repo. |
| `register` | Validates `.centaur.yml`, requests a GitHub OIDC token for the poster's audience and invokes `register`. |
| `turn` | One agent turn: answers a dispatched chat message, or (with `prompt_name`) starts a new thread from a scheduled prompt. Outputs `skip` and `pull-request-url`. |
| `notify-failure` | Posts a failure notice in the thread and clears the 👀 reactions. Use with `if: failure()`; does nothing if the turn never started. |

## Consumer workflows

Each file has its own triggers; no `if: github.event_name` branching.

```yaml
# .github/workflows/centaur-register.yml
name: Centaur register
on:
  push:
    branches: [main]
    paths: [.centaur.yml]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  register:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/register@main
```

```yaml
# .github/workflows/centaur-message.yml
name: Centaur message
on:
  repository_dispatch:
    types: [centaur-message]
permissions:
  contents: write
  pull-requests: write
  id-token: write
concurrency:
  group: centaur-${{ github.event.client_payload.bot }}-${{ github.event.client_payload.thread_key }}
  cancel-in-progress: false
jobs:
  turn:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/turn@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: failure()
        uses: <owner>/centaur/.github/actions/notify-failure@main
```

```yaml
# .github/workflows/centaur-weekly-tasks.yml
name: Centaur weekly tasks
on:
  schedule:
    - cron: "0 15 * * 6"
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  id-token: write
jobs:
  weekly-tasks:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/turn@main
        with:
          prompt_name: weekly-tasks
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: failure()
        uses: <owner>/centaur/.github/actions/notify-failure@main
```

Pin `@main` to a tag or SHA for stability. Callers must grant the permissions shown:
`id-token: write` for AWS and the registration token, `contents: write` and `pull-requests: write`
for the agent's pull request. Enable "Allow GitHub Actions to create and approve pull requests" in the
repo settings. Pull requests opened with the default token do not trigger other workflows.

To add another scheduled prompt, add a `prompts:` entry to `.centaur.yml` and a workflow like the
last one. Because the consumer owns the job, it can add its own steps before or after the actions
(for example to fetch data the prompt needs).

## This repo as a test consumer

This repo is its own consumer, for end-to-end testing: `.centaur.yml` binds the `centaur-test` bot
and the `centaur-*.yml` workflows use the actions locally (`uses: ./.github/actions/...`). Its agent
is read-only (`Read,Glob,Grep`) and it uses `respond_to: all`.

Run **Actions > Centaur register** to bind the bot, or **Actions > Centaur hello** to start a thread
from `.centaur/prompts/hello.md`. Messages sent to the bot dispatch `centaur-message` and are
answered by **Centaur message**.

## Variables and secrets

Set as repository or organization **variables**:

| Variable | Value |
|---|---|
| `CENTAUR_ROLE_ARN` | `RoleArn` output of the stack (assumed through OIDC; no AWS keys are stored). |
| `CENTAUR_AWS_REGION` | Region of the stack. |
| `CENTAUR_FUNCTION_NAME` | Name of the receiver/poster Lambda function. |
| `CENTAUR_OIDC_AUDIENCE` | The poster's `OIDC_AUDIENCE`. |
| `CENTAUR_SESSION_BUCKET` | `BucketName` output (agent turns only). |

The API base URL comes from the bot's `provider` in `.centaur.yml`, not from a variable.

**Secret** the API key named by the bot's `provider` (`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`), plus anything the agent's tools need.

## How the scripts are delivered

Actions run from the checkout GitHub makes of this repo at the ref the consumer pins
(`github.action_path`). `setup-runtime` enables Corepack and runs `yarn install --immutable &&
yarn build` there; the other actions run
`node <action checkout>/dist/workflows/cli.js <command>`. This keeps the scripts versioned with theactions that call them, and all non-trivial logic in `src/workflows/` where it is unit-tested. The
centaur repo must be readable by the consumer's `GITHUB_TOKEN` (public, or granted access).
`.centaur-turn/` is added to `.git/info/exclude` so it never lands in a pull request. The actions
read the variables above through the `vars` context; API keys are inputs of `turn` because
composite actions cannot read secrets.

Commands: `register`, `prepare`, `pr-details`, `finish`, `notify-failure`.

## Agent turn

1. `prepare` reads `.centaur.yml`, reads the thread from the poster (`read`), determines the
   unprocessed messages and the context policy, and writes the prompt to `.centaur-turn/prompt.md`.
   It copies the images attached to the messages the prompt shows (pending ones, plus the earlier
   ones when the history is included) from the session bucket into `.centaur-turn/attachments/`,
   newest 10 at most, and lists each by path under its message; older images are listed as not
   loaded. A failed copy fails the turn.
   When `mcp_servers` is set, it writes `.centaur-turn/mcp.json` (secrets as `${NAME}` references,
   never values) and adds `--mcp-config` to `claude_args`; a referenced secret missing from the
   step's environment fails `prepare` before anything is posted, naming it ([mcp.md](mcp.md)).
   It outputs the `claude_args` (model and tuning flags, `--allowedTools`, `--json-schema` requiring `reply` (or, for `respond_to: all` threads, `reply` or `ignore: true`; optionally `pr_title` and `pr_body`), persona
   via `--append-system-prompt-file`, `--resume <id>`). When there is nothing to do (everything
   processed, or only a `/resume` or `/transcript` command, which is acknowledged in the thread),
   the remaining steps are skipped.
2. `claude-code-action` runs with a constant prompt telling it to read the prompt file. If
   `allowed_tools` lacks `Read`, `Read(./.centaur-turn/**)` is added so it can.
3. `pr-details` builds the pull request title and body from the agent's optional `pr_title` and
   `pr_body` structured output (see below). `create-pull-request` then opens (or updates)
   `centaur/<bot>-<thread>` when files changed, using the title as both commit message and title.
4. `finish` takes the reply from the action's execution file, appends the pull request link, posts
   it (`post`, or `start-thread` for scheduled prompts and `/new`; `prepare` records the target in
   the turn state: the prompt's `destination` alias, which the poster resolves to a chat approved for the bot, or the originating thread for `/new`), advances the marker and saves the
   session for `resume` threads. When the agent returned `ignore: true` nothing is posted unless a
   pull request was opened, in which case only its link is posted;  the marker and session are still saved.
   When `create-pull-request` produced a pull request, `finish` also links it to the thread it
   replied in (for scheduled prompts, the thread just started) with the poster's
   `link-pull-request`, authenticated by the same OIDC token as `register`; a failure is a warning
   and never fails the turn.
   Last, it removes the 👀 reaction (`unreact`) from every message the turn processed, so a message
   that still shows 👀 is still being worked on.
5. On failure, `notify-failure` posts a generic notice with the run URL, then removes the 👀
   reactions; the marker is not advanced, so the messages are retried on the next turn.

`prepare` records the thread and the IDs of the pending messages (IDs only, no content) in
`.centaur-turn/state.json` for `finish` and `notify-failure`. Turns that end in `prepare`
(acknowledged policy commands, a bare `/new`) clear the reactions there. Removing reactions is
best-effort: a failure is logged as a warning and never fails the job or holds back the reply. If
`prepare` itself fails before writing the state, the reactions stay.

The schema also accepts optional `pr_title` and `pr_body`, which the prompt tells the agent to set
when it edits files. `pr-details` treats them as untrusted: the title is flattened to one line and
cut to 100 characters, the body is cut to 4000 characters, control characters are removed, and both
reach `create-pull-request` as step outputs passed to action inputs, never interpolated into a shell script. The body is
followed by a footer linking the workflow run and naming the bot and the scheduled prompt (never the
thread ID). When a field is missing or empty the title is `Centaur agent changes` (with `: <prompt
name>` for scheduled prompts) and the body is the footer alone.

`concurrency: centaur-<bot>-<thread key>` serializes turns per thread, where the thread key is the
first 12 hex characters of a SHA-256 over the bot and thread ID (`src/thread-key.ts`), computed by
the receiver and carried in the dispatch payload as `thread_key`. The PR branch is
`centaur/<bot>-<thread key>` and stays the same across a thread's turns; scheduled runs use
`<prompt>-<run id>` for the branch and need no group.

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

- `/new [text]`: acknowledges in the current thread, then starts a new thread in the same chat
  (`start-thread` with `fromThreadId`), seeded with `text` and any later pending messages (a bare
  `/new` opens an empty thread without running the agent).
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
- Thread IDs (chat IDs) do not appear in the concurrency group name or in pull request branch
  names; both use the hashed thread key. The dispatch payload still carries the raw `thread_id`,
  which GitHub does not show in the Actions UI or logs.

## Not implemented

Transcript size budgeting: `read` returns the whole stored transcript (up to 100 messages) and it
is placed in the prompt unmodified.
