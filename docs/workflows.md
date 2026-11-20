# Shared workflow actions

Consumer repos compose composite actions from this repo's `.github/actions/` into their own
workflows, one workflow per concern (register, chat messages, each scheduled prompt). See
[plan.md](plan.md#shared-actions-centaurgithubactions) for the design, [poster.md](poster.md) for the
operations they invoke, and [config.md](config.md) for `.centaur.yml`.

| Action | Purpose |
|---|---|
| `setup-runtime` | Builds the workflow scripts from the action's own checkout and assumes the AWS role through OIDC. Run once per job, after checking out the consumer repo. |
| `register` | Validates `.centaur.yml`, requests a GitHub OIDC token for the poster's audience and invokes `register`. |
| `resolve-pr-comment` | Decides whether a pull request comment event starts a turn and which bot and thread it belongs to; see [Comment turns](#comment-turns). |
| `turn` | One agent turn: answers a dispatched chat message, or (with `prompt_name`) starts a new thread from a scheduled prompt, or (with `comment`) answers the comments on a pull request. Outputs `skip` and `pull-request-url`. |
| `notify-failure` | Posts a failure notice in the thread (and, with `comment`, on the pull request) and clears the 👀 reactions. Use with `if: failure()`; does nothing if the turn never started. |

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

## MCP server secrets

Composite actions cannot read `secrets.*`, so a secret named in `mcp_servers` reaches the turn only
through `env:` on the `turn` step. List exactly the secrets the config references; the config cannot
use any the caller did not list. For this `.centaur.yml`:

```yaml
mcp_servers:
  tracker:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: { secret: TRACKER_API_KEY, prefix: "Bearer " }
allowed_tools: "Read,mcp__tracker__*"
```

the caller's `turn` step is:

```yaml
      - uses: <owner>/centaur/.github/actions/turn@main
        env:
          TRACKER_API_KEY: ${{ secrets.TRACKER_API_KEY }}
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

`.centaur-turn/mcp.json` holds `Bearer ${TRACKER_API_KEY}`, never the value. If a referenced secret
is unset or empty, `prepare` fails the turn naming it.

The secret is also in the environment of the agent process, so an allowed `Bash` tool can read it.
Keep `Bash` out of `allowed_tools` for repos that pass MCP secrets, or accept that the agent can
read them.

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

Commands: `register`, `resolve`, `prepare`, `pr-details`, `finish`, `notify-failure`.

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
   The prompt's instructions are the guidance from `instructions/{chat,comment,silence}.md` (or
   the repo's `instructions` overrides in `.centaur.yml`, read from the checkout like the persona)
   followed by fixed text in `prompt.ts`: the untrusted-input warning and the structured-output
   fields the workflow parses (`reply`, `ignore`, `pr_title`, ...), which a repo cannot override.
   It outputs the `claude_args` (model and tuning flags, `--allowedTools`, `--json-schema` requiring `reply` (or, for `respond_to: all` threads, `reply` or `ignore: true`; optionally `pr_title`, `pr_body`, and the `pr_action` or `existing_pr_number` target field when enabled), persona
   via `--append-system-prompt-file`, `--resume <id>`). When there is nothing to do (everything
   processed, or only a `/resume` or `/transcript` command, which is acknowledged in the thread),
   the remaining steps are skipped.
2. `claude-code-action` runs with a constant prompt telling it to read the prompt file. If
   `allowed_tools` lacks `Read`, `Read(./.centaur-turn/**)` is added so it can.
3. `pr-details` builds the pull request title and body from the agent's optional `pr_title` and
   `pr_body` structured output (see below). `plan-pr` then decides where the changes land (see
   below). Unless the plan chose an existing pull request and `push-existing` updated it,
   `create-pull-request` opens (or updates) `centaur/<bot>-<thread>` when files changed, using the
   title as both commit message and title.
4. `finish` takes the reply from the action's execution file, appends the pull request link, posts
   it (`post`, or `start-thread` for scheduled prompts and `/new`; `prepare` records the target in
   the turn state: the prompt's `destination` alias, which the poster resolves to a chat approved for the bot, or the originating thread for `/new`), advances the marker and saves the
   session for `resume` threads. When the agent returned `ignore: true` nothing is posted unless a
   pull request was opened or updated, in which case only its link is posted;  the marker and session are still saved.
   The link reads `Pull request: <url>`, or `Updated pull request: <url>` when `push-existing`
   updated an existing one (it also posts a `<!-- centaur:reply -->` conversation comment there
   with the title and body, leaving the pull request's own title and body alone). When the
   agent's choice fell back, the note adds `Could not update #N (<reason>); opened the usual pull
   request instead.`, with the reason code from `plan-pr` or `push-existing`; it is omitted when no
   pull request was opened.
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

### Choosing the pull request

Two more optional fields choose the pull request a turn targets, each present only when
`pull_requests` in `.centaur.yml` enables it: `pr_action` (`update` or `new`, comment turns) and
`existing_pr_number` (a positive integer, chat and scheduled turns). `extractResult` returns them as
`prAction` and `existingPr`; a malformed value fails the reply like any other schema violation, and
`finish` ignores a field that does not fit the turn's mode with a `::warning::` that names no
content.

`prepare` lists the pull requests a chat or scheduled turn may update when `existing` is `bot`:
open pull requests of this repository, not forks, from `centaur/<bot>-` branches authored by
`github-actions[bot]`, newest 10 by number. When the poster has a `resolve-pull-request` record it
must name the same bot; a missing record is allowed (older pull requests predate linking), and a
poster error excludes the pull request. The prompt gets an "Open pull requests you may update"
section of numbers and fenced titles, noted as data, and the schema gets `existing_pr_number`. With
no candidates, or when GitHub fails (a `::warning::`, never a failed turn), the section, the field
and the "number must be listed" sentence are all omitted. `prepare` needs `GITHUB_REPOSITORY` and
`GITHUB_TOKEN` for this and lists nothing without them. Comment turns list nothing.

`centaur-workflow plan-pr` re-derives the same candidate set from GitHub, never from
`.centaur-turn/state.json`, and checks the agent's `existing_pr_number`, read from the execution
file (`EXECUTION_FILE`) like `pr-details` and `finish` do, against it. With `existing: off` or
without `GITHUB_TOKEN` it plans `thread` without calling GitHub. It reads `.centaur.yml` from
`CENTAUR_CONFIG_ROOT` when set. It writes the outputs
`target` (`existing` or `thread`), `number` and `head_ref` for `existing`, and `fallback_reason`
for `thread` (`not_open`, `not_candidate`, `not_allowed`, `lookup_failed`, or empty), none of which
carries pull request content. An absent or malformed number means `thread` with no reason.

`centaur-workflow push-existing` moves the agent's changes onto the planned pull request without
touching the workspace. It reads `TARGET_HEAD_REF` and `TARGET_PR_NUMBER` (the `plan-pr` outputs)
and `PR_TITLE` for the commit message. It stages everything except `.centaur-turn` and
`.centaur-trusted`, writes a binary patch to the runner temp directory, fetches the branch, adds a
detached worktree at its tip, runs `git apply --3way --index`, commits as `github-actions[bot]` and
pushes with plain `git push` (never forced). It validates `TARGET_HEAD_REF` first (`centaur/`
prefix, no `..`, no whitespace or leading dash). Outputs: `fallback` (`true` on any failure),
`reason` (`invalid_ref`, `patch_failed`, `fetch_failed`, `conflict`, `push_rejected`; never file
contents), and on success `pull-request-url` and `pull-request-number`. With no changes it succeeds
and sets neither. On failure the worktree is removed and the workspace is as the agent left it, so
the action falls back to `create-pull-request`, which runs when the plan is `thread` or
`push-existing` reported `fallback`. `push-existing` runs only for an `existing` plan; the
action passes `TARGET_HEAD_REF`, `TARGET_PR_NUMBER` and the `pr-details` title as `PR_TITLE`.
`finish` receives `PULL_REQUEST_URL` and `PULL_REQUEST_NUMBER` from whichever step produced the
pull request, `PULL_REQUEST_UPDATED` (`true` when `push-existing` updated one),
`FALLBACK_REASON` and `RUN_URL`. An updated existing pull request is not linked to the current
thread; `resolve-pull-request` already refreshed its link while the plan was validated.

**Validity.** `checkCandidate` (`src/workflows/pr-target.ts`) is the only place a target is
validated, for both the prompt's list and `plan-pr`. A pull request is valid when it is open, its
base and head repositories are both this repository (not a fork), its head branch starts with
`centaur/<bot>-`, it was opened by `github-actions[bot]`, and, when the poster has a
`resolve-pull-request` record for it, the record names the same bot. A missing record passes; a
poster failure rejects.

**Fallbacks.** A target that is absent, malformed or invalid never fails the turn. The changes go
to the thread's normal pull request (`centaur/<bot>-<thread key>`), as if no number was given.
`plan-pr` rejects with `not_open`, `not_candidate` (wrong repository, branch, or author),
`not_allowed` (the record names another bot) or `lookup_failed` (a GitHub or poster error), and
logs a `::notice::` with the code. An absent or malformed number and `existing: off` fall back
without a reason. `push-existing` falls back with its own reason (`invalid_ref`, `patch_failed`,
`fetch_failed`, `conflict`, `push_rejected`), leaving the workspace untouched so the usual pull
request is opened from it. Whenever the agent named a number and a pull request was then opened
for the thread, `finish` appends `Could not update #N (<reason>); opened the usual pull request
instead.` to the chat reply, for `plan-pr` rejections as well as `push-existing` failures. Nothing
is added when the plan fell back without a reason or no pull request was opened (no file changes).

**Updating.** An update is one plain commit, pushed without force to the target's branch, plus a
marked conversation comment with the new title and body. The pull request's own title and body are
not edited and it is not linked to the current thread.

**Stacking.** For a comment turn's `pr_action: new`, the base is the original pull request's head
branch when its head commit is an ancestor of the working tree, else the default branch
([Comment turns](#comment-turns)).

**Security.** The agent can write `.centaur-turn/state.json`, so nothing in it decides a target:
`plan-pr` re-derives the candidate set from GitHub and the poster, and `existing_pr_number` is read
from the action's execution file and checked against that set. Poster operations and the
repository come from the verified OIDC claim and the workflow's environment, never from agent
output. A pull request number is only an index into the validated set. Pull request titles in the
prompt are fenced as data. The push uses the workflow's `GITHUB_TOKEN`, so it is subject to the
branch protection or rulesets of the target branch, and, like every push made with that token, it
does not trigger workflows (see [plan.md](plan.md#security)).

**Reviewing agent updates.** An update adds commits to a pull request that may already be
approved. In repositories that require approvals, enable "Dismiss stale pull request approvals when
new commits are pushed" in the branch protection rule or ruleset for the default branch, so an
agent update cannot ride an earlier approval. Also protect the default branch (required reviews or
rulesets), since Centaur never merges and relies on that review. Setting `pull_requests.existing:
off` removes the path.

### Comment turns

A pull request comment turn answers the comments on a pull request the agent opened. It is
designed in [pr-comments.md](pr-comments.md). Consumers copy
[`centaur-pr-comment.yml`](../.github/workflows/centaur-pr-comment.yml) (triggers `issue_comment` and
`pull_request_review`). Two jobs make it up:

- `resolve` runs `resolve-pr-comment` (the `resolve` command) with `GITHUB_TOKEN`, the OIDC token
  and the role variables. It needs `pull-requests: read` and `id-token: write`, and
  `CENTAUR_OIDC_AUDIENCE` in its environment, because it asks the poster to resolve the pull
  request. Outputs: `skip`, `bot`, `thread_key`, `head_ref`, `pull_request`.
- `turn` checks out `head_ref` as the agent's working tree, runs the `turn` action with `comment: <pull_request>` and the same
  concurrency group as chat turns of that thread, and `notify-failure` with the same `comment`.
  It needs `contents: write`, `pull-requests: write` and `id-token: write`.

The actions and runtime must not come from the pull request checkout, since the turn holds write
tokens and the OIDC role. Consumers using `blevinstein/centaur/.github/actions/...@main` already
get that; they may also pass `config_root` (a checkout of the default branch) so that `.centaur.yml`,
the instructions and the persona are read from the default branch instead of the pull request
branch. This repo, which uses its own actions locally, checks out the default branch into
`.centaur-trusted` and runs `./.centaur-trusted/.github/actions/...`. See
[Trust boundary](pr-comments.md#trust-boundary).

With `comment` set, the action passes `COMMENT_PULL_REQUEST` and `GITHUB_TOKEN` to `prepare`,
`finish` and `notify-failure` (and `CENTAUR_CONFIG_ROOT` to `prepare` and `finish`, so `finish`
reads `pull_requests.comment_new` from the trusted config root, not the pull request branch), and skips `pr-details` and `create-pull-request`. The steps differ
from a chat turn as follows:

- `prepare` (comment mode) resolves the thread through the poster (masking the raw thread ID),
  answers every human comment newer than the agent's latest marked comment, and records
  `mode: comment`, `pullRequest` and, when the comments are all in one inline thread, `replyTo` in
  the turn state. It writes no marker and clears no reactions; the output `branch` is the pull
  request head.
- `finish` first commits and pushes: working tree changes (excluding `.centaur-turn/`) are
  committed as `github-actions[bot]` with the agent's `pr_title` (cleaned like a pull request
  title, default `Address review comments`), then a plain `git push` updates the branch. Then it
  posts the `reply` as a pull request comment, with `<!-- centaur:reply -->` as its first line:
  a reply in the inline thread when `replyTo` is set, else a conversation comment. For
  `ignore: true` nothing is posted unless commits were pushed, in which case the comment is
  `Pushed N commit(s).`. It then posts a note in the chat thread, `Replied on <pull request URL>`
  plus `and pushed N commit(s)` (or `Pushed N commit(s) to <URL>`), never any comment content, and
  refreshes the pull request's thread record with `link-pull-request`. The chat note and the
  record refresh are warnings on failure; a failed push or comment fails the turn. For `resume`
  threads the session is saved; the chat marker is never touched.
- `pr_action: new` (when `pull_requests.comment_new` is on) makes `finish` open a separate pull
  request instead of pushing to the original branch, which gets no new commits. Trusted code
  creates the branch `centaur/<bot>-<thread key>-<run id>-<run attempt>` (the `centaur/` prefix
  keeps later comments resolvable), commits the working tree changes as `github-actions[bot]`
  with the cleaned `pr_title` (default `Centaur agent changes`, with a warning when it is missing)
  and pushes with plain `git push`; a failed push fails the turn. The base is the original pull
  request's head branch when its head commit is an ancestor of the new branch (the new pull
  request says `Stacked on #N`), otherwise the default branch. The body is the cleaned `pr_body`
  plus a footer naming the comment's pull request and the run. The marked reply on the original
  pull request is the agent's `reply` plus `Opened #M for this.` (or a note that nothing changed
  and no pull request was opened). The chat note is `Opened #M from comment on #N: <URL>`, and
  `link-pull-request` is called for both pull requests, so a comment on the new one resolves to the
  same thread. The turn action does not need to change for this: it already passes
  `GITHUB_RUN_ID`, and `finish` also reads `GITHUB_RUN_ATTEMPT`, `GITHUB_SERVER_URL` and the
  config.
- `notify-failure` posts its notice to the chat thread and, marked, to the pull request (inside
  the inline thread when `replyTo` is set).

Comment text and replies are never logged; `GITHUB_TOKEN` and the OIDC token are masked or
Actions-masked, and the raw thread ID is never printed.

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
