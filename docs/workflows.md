# Shared workflow actions

Consumer repos compose composite actions from this repo's `.github/actions/` into their own
workflows, one workflow per concern (register, chat messages, each scheduled prompt). See
[plan.md](plan.md#shared-actions-centaurgithubactions) for the design, [poster.md](poster.md) for the
operations they invoke, and [config.md](config.md) for the config.

| Action | Purpose |
|---|---|
| `setup-runtime` | Builds the workflow scripts from the action's own checkout and assumes the AWS role through OIDC. Run once per job, after checking out the consumer repo. |
| `register` | Validates the config (at `root`, default the repo root), requests a GitHub OIDC token for the poster's audience and invokes `register`. |
| `resolve-pr-comment` | Decides whether a pull request comment event starts a turn and which bot and thread it belongs to; see [Comment turns](#comment-turns). |
| `resolve-schedule` | Computes the concurrency group of a scheduled prompt's turn job (config at `root`); see [Persistent scheduled threads](#persistent-scheduled-threads). |
| `turn` | One agent turn: answers a dispatched chat message, or (with `prompt_name`) starts a new thread from a scheduled prompt, or (with `comment`) answers the comments on a pull request. Outputs `skip` and `pull-request-url`. Reads the config from `root`; see [Bots in sub-folders](#bots-in-sub-folders). |
| `notify-failure` | Posts a failure notice in the thread (and, with `comment`, on the pull request) and clears the 👀 reactions. Use with `if: failure()`; does nothing if the turn never started. |

## Consumer workflows

Each file has its own triggers; no `if: github.event_name` branching.

```yaml
# .github/workflows/centaur-register.yml
name: Centaur register
on:
  push:
    branches: [main]
    paths: [.centaur.yml, .centaur/config.yml]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  register:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
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
        with:
          fetch-depth: 0
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
  resolve:
    runs-on: ubuntu-latest
    outputs:
      group: ${{ steps.resolve.outputs.group }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - id: resolve
        uses: <owner>/centaur/.github/actions/resolve-schedule@main
        with:
          prompt_name: weekly-tasks
  weekly-tasks:
    needs: resolve
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: ${{ needs.resolve.outputs.group }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/turn@main
        with:
          prompt_name: weekly-tasks
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: failure()
        uses: <owner>/centaur/.github/actions/notify-failure@main
```

Every centaur entrypoint checks out full history (`fetch-depth: 0`), so each job and the agent see
the same repository state and the agent can read `git log`, `git blame` and older files; the default
shallow checkout shows one commit. A very large repository can set a smaller `fetch-depth` at the
cost of history questions. The `.centaur-trusted` checkout in the pull request comment workflow only
supplies the trusted config and actions, so it stays shallow.

Pin `@main` to a tag or SHA for stability. Callers must grant the permissions shown:
`id-token: write` for AWS and the registration token, `contents: write` and `pull-requests: write`
for the agent's pull request. Enable "Allow GitHub Actions to create and approve pull requests" in the
repo settings. Pull requests opened with the default token do not trigger other workflows.

To add another scheduled prompt, add a `prompts:` entry to the config and a workflow like the
last one. Because the consumer owns the job, it can add its own steps before or after the actions
(for example to fetch data the prompt needs).

## Persistent scheduled threads

A prompt with `thread: persistent` ([config.md](config.md#prompts)) posts every run into the
destination's one thread instead of a new one, and the run sees what the thread already holds.

- **Finding the thread.** Before the agent runs, `prepare` calls the poster's `resolve-destination`
  with `thread: persistent` for the prompt's first target. It returns `threadId` only when the
  destination has a bound thread; for a destination with none (the first run) there is no history,
  and the run starts empty. Only the first target is read; the other targets of a fan-out prompt
  start their threads in `finish`.
- **Context.** With a bound thread, `prepare` reads it (`read`) and builds the prompt like a chat
  reply: the human messages after the thread's last-processed marker are shown as the new messages,
  and the earlier messages as the transcript, bounded by `context.transcript_max_chars`
  ([Transcript budget](#transcript-budget)) with the omission note. The policy is the latest
  `/resume` or `/transcript` in the thread, else the prompt's own `context`: every run rewrites the
  thread's stored policy from the prompt, so the stored value is the prompt's from the last run and
  reading it would keep a changed `context` from taking effect. A `resume` prompt restores the
  session saved under the destination thread, and falls back to the transcript when none exists.
- **Posting.** `finish` adds `thread: persistent` to each `start-thread` request, and only for a
  persistent prompt: a `new` prompt sends no `thread`, so it works against a poster that predates
  the field. The thread each call returns is used like a new thread's: the first target that
  received the reply is the primary thread and takes the marker (the last message `prepare` read;
  the run's own post comes after it and is never pending), the saved session and the pull request
  link. The marker is stored only when the primary thread is the one it was read from.
- **Concurrency.** The `resolve-schedule` action (the `resolve` job in the template) outputs the
  turn job's `concurrency` group. For a persistent prompt it is `centaur-<bot>-<key>`, with the key
  a hash (`src/thread-key.ts`) of the bot and the sorted `<platform>/<destination>` names of the
  prompt's targets, so runs of the prompt queue instead of interleaving, including the first run
  that creates the thread, and no chat or thread ID appears in the name. Any other prompt gets
  `centaur-<bot>-<prompt>-<run id>`, which serializes nothing. Two prompts that share a destination
  but not the same targets use different groups. Replies from humans are chat turns in the thread's
  own group; they are not serialized with the scheduled run.
- **Deploy order.** The runner calls `resolve-destination` and sends `thread` to `start-thread`,
  which the poster Lambda must understand first. Deploy the Lambda (`yarn deploy-prod`) before any
  config sets `thread: persistent`; prompts without it work against either Lambda.

## Bots in sub-folders

A monorepo can keep a bot's config and files under a sub-folder, and run one bot per sub-folder. Each
of `register`, `turn`, `resolve-pr-comment` and `resolve-schedule` takes a `root` input (default `.`,
the repo root, so existing workflows are unchanged): a directory relative to the repo root that holds
`.centaur.yml` or `.centaur/config.yml`. The action passes it to its steps as `CENTAUR_ROOT`. The
config's `persona`, `instructions` and prompt `file` paths, the default `.centaur/` paths, the consumer
skills in `.claude/skills` and the MCP policy `.centaur/mcp-policy.cedar` are all relative to `root`.
`root` comes only from the workflow YAML, never from the config or the pull request. See
[subfolder-support](proposals/subfolder-support.md) for the design.

- **One style per repo.** A repo uses either a config at its top or configs in sub-folders, never
  both; `register` and `prepare` fail naming both paths otherwise. A repo that wants a sub-folder bot
  moves its root bot into a folder first.
- **The agent still runs at the repo root.** `prepare` adds a `Project folder` section to the prompt
  naming `root` and, when `<root>/AGENTS.md` or `<root>/CLAUDE.md` exists, telling the agent to read
  it first. It is guidance, not confinement: the workspace, the token and the commit cover the whole
  repository.
- **Register once per root.** Each bot has its own `register` job with `root`, and the `paths` filter
  lists every sub-folder's config. All bots bind to the same repository.
- **Filter dispatches by bot.** Every `repository_dispatch` reaches every `centaur-message` workflow
  in the repo, so each bot's caller workflow runs its job only when
  `github.event.client_payload.bot` is its bot.
- **Share the steps in a reusable workflow.** A `workflow_call` workflow takes `bot` and `root`; each
  bot's thin caller supplies the trigger, the filter and the two values.
- **Distinct concurrency groups.** The group is built from the `bot` input, so two bots' turns never
  queue behind or cancel each other.

```yaml
# .github/workflows/centaur-register.yml
name: Centaur register
on:
  push:
    branches: [main]
    paths:
      - apps/garden/.centaur.yml
      - apps/garden/.centaur/**
      - apps/shop/.centaur.yml
      - apps/shop/.centaur/**
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  register:
    strategy:
      matrix:
        root: [apps/garden, apps/shop]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/register@main
        with:
          root: ${{ matrix.root }}
```

```yaml
# .github/workflows/centaur-garden-message.yml (one per bot)
name: Centaur garden message
on:
  repository_dispatch:
    types: [centaur-message]
permissions:
  contents: write
  pull-requests: write
  id-token: write
jobs:
  turn:
    if: github.event.client_payload.bot == 'garden'
    uses: ./.github/workflows/centaur-turn.yml
    with:
      bot: garden
      root: apps/garden
    secrets: inherit
```

```yaml
# .github/workflows/centaur-turn.yml (reusable)
name: Centaur turn
on:
  workflow_call:
    inputs:
      bot: { type: string, required: true }
      root: { type: string, required: true }
concurrency:
  group: centaur-${{ inputs.bot }}-${{ github.event.client_payload.thread_key }}
  cancel-in-progress: false
jobs:
  turn:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/turn@main
        with:
          root: ${{ inputs.root }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: failure()
        uses: <owner>/centaur/.github/actions/notify-failure@main
```

Scheduled prompts pass `root` to both `resolve-schedule` and `turn`. For pull request comments, keep
one copy of the comment workflow per bot that passes `root` to `resolve-pr-comment` and `turn`
(`root` is read inside `config_root`, the trusted checkout),
and skip the `turn` job unless `needs.resolve.outputs.bot` is that bot.

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

## Approval-required MCP servers

When the [operator policy](mcp.md#operator-policy) makes a server approval-required, `prepare` calls
the poster [`mcp-approvals`](poster.md#mcp-approvals) once per turn and starts the turn with the
approved servers only; `pending` and `denied` servers are dropped from `mcp.json` and from
`--allowedTools` (including `mcp__<name>__*` entries). A poster failure counts as `pending`. Nothing
is polled: a decision that arrives later is used by the next turn. A turn with a thread (chat,
`/new`, pull request comment turns and persistent scheduled prompts) can raise the request; a
scheduled prompt without a persistent thread only reads stored decisions.

The prompt gets one `# MCP server approvals` section: the servers awaiting the admin, with their
tools, and a line for each server the admin denied ("answer without it").

A chat turn that replies in an existing thread, and whose poster answer left servers pending, also
gets one sentence telling the agent it may return `suspend_for`, an array of up to 20 server names,
instead of working around the absence; the schema offers the field only then. `prepare` records the
pending servers (names, fingerprints, summaries) and the thread in the turn state, and `finish`
honors only entries in that record, so a name that is not pending, or any `suspend_for` on a turn
that cannot suspend, is ignored. The sentence also asks for a `reply`, but a non-empty `suspend_for`
is accepted without one (and without `ignore`); `finish` then posts `waitingReply` ("Waiting for the
admin to approve <servers>, then I'll carry on."), while an output whose `suspend_for` names no
pending server and has no reply fails like one with no reply at all. A valid `suspend_for` posts the reply and clears the reactions as
usual and saves the session, but leaves the last-processed marker where it was and calls
`mcp-approvals` with `suspend: true` for the named servers; the decision then re-dispatches the
thread. If that call fails, `finish` logs the error type only and ends as an ordinary turn,
advancing the marker so the thread is not left replaying messages that no decision will resume.
`finish` needs the OIDC token for that call, which the turn action already provides. The design,
including the races, is in [mcp-approval.md](mcp-approval.md#suspend-and-resume).

## This repo as a test consumer

This repo is its own consumer, for end-to-end testing, with its bot in the sub-folder `apps/centaur-test`
(see [Bots in sub-folders](#bots-in-sub-folders)): `apps/centaur-test/.centaur/config.yml` binds the `centaur-slack` bot to Slack and Telegram
and the `centaur-*.yml` workflows use the actions locally (`uses: ./.github/actions/...`) with `root: apps/centaur-test`.
`centaur-register.yml` runs `register` over a matrix of roots, `centaur-test-message.yml` calls the reusable `centaur-turn.yml`
for the bot's dispatches, `centaur-hello.yml` takes the root as a dispatch input, and `centaur-pr-comment.yml` sets `root` directly.
A second bot adds a root to the register matrix and filter, a message caller, a hello option and a comment workflow copy
([two-bot-test](proposals/two-bot-test.md)). Its agent is
read-write on the repo (`Read,Glob,Grep,Write,Edit` plus the read-only GitHub MCP tools), and it uses `respond_to: all` on both platforms. Its `hello` and `mcp-smoke` prompts post to Slack and Telegram, `hello-telegram` (the `hello` text) to Telegram only, keeping one persistent thread (`thread: persistent`; the other prompts open a new thread each run), and the pull-request prompts (`pr-smoke`, `pr-update`) post to Slack only, since a PR attaches to one thread.

Run **Actions > Centaur register** to bind the bot, or **Actions > Centaur hello** to start a thread
from `apps/centaur-test/.centaur/prompts/hello.md`. Messages sent to the bot dispatch `centaur-message` and are
answered by **Centaur message**.

## Variables and secrets

Set as repository or organization **variables**. `centaur repo vars` (run in the repo, or with
`--repo OWNER/REPO` / `--org ORG`) reads them from the stack and sets them with `gh` (`--dry-run`
prints them instead):

| Variable | Value |
|---|---|
| `CENTAUR_ROLE_ARN` | `RoleArn` output of the stack (assumed through OIDC; no AWS keys are stored). |
| `CENTAUR_AWS_REGION` | Region of the stack. |
| `CENTAUR_FUNCTION_NAME` | Name of the receiver/poster Lambda function. |
| `CENTAUR_OIDC_AUDIENCE` | The poster's `OIDC_AUDIENCE`. |
| `CENTAUR_SESSION_BUCKET` | `BucketName` output (agent turns only). |

The poster client in the workflow scripts attaches the job's OIDC token to every poster call,
including `post`, `unreact`, `start-thread` and `get-mcp-policy`, which the poster checks against the
bot's bound repo once `RequirePosterToken` is on ([poster.md](poster.md#security-model)). Every job
that runs the scripts therefore needs `id-token: write`, as the examples above already grant.

The API base URL comes from the bot's `provider` in the config, not from a variable.

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

Commands: `register`, `resolve`, `resolve-schedule`, `prepare`, `pr-details`, `finish`, `notify-failure`.

## Skills

`prepare` installs agent skills into the runner's user skills directory before it builds
`claude_args` (`installSkills`, `src/workflows/skills.ts`), unless `skills` in the config turns them
off ([config.md](config.md)):

- **Built-in.** The repository's `skills/centaur-*/SKILL.md` (path from the `CENTAUR_SKILLS_DIR`
  environment variable that the turn action sets to `<action>/../../../skills`) are copied to
  `$HOME/.claude/skills/centaur-*` after removing every stale `centaur-*` folder there. A personal
  skill outranks a project skill of the same name, so a pull request branch cannot shadow one. The
  prompt gains a short "Skills" section pointing at them.
- **Consumer.** Skills from `.claude/skills` of the trusted checkout (`config_root`, so the default
  branch for a pull request comment turn) are copied as `centaur-consumer-<name>`. A skill whose
  folder name starts with `centaur-`, whose frontmatter `name` differs from its folder, that sets
  `hooks`, contains `.claude-plugin` or a symbolic link, or whose `allowed-tools` names a tool outside
  the config's `allowed_tools` fails the turn with a message naming the skill.
- `Skill` is added to `--allowedTools` when any skill was installed.
- A comment turn also passes `--setting-sources user`, so the pull request branch's
  `.claude/skills`, `.claude/settings.json`, rules and `CLAUDE.md` are not loaded; a chat turn keeps
  the action's default sources. The trusted guide reaches a comment turn through a copy in `$HOME/.claude/CLAUDE.md` (see
  [Repository instructions](#repository-instructions)); `project` and `local` stay off.

See [skills-rules.md](skills-rules.md) for the design and the live check.

## Repository instructions

`prepare` also installs the repository's guide (`installRepositoryInstructions`,
`src/workflows/repository-instructions.ts`), unless `repository_instructions.enabled` is `false`
([config.md](config.md)). It writes the Centaur root's `AGENTS.md`, else `CLAUDE.md`, to
`$HOME/.claude/CLAUDE.md`, the user memory that Claude Code reads under `--setting-sources user`, so
a comment turn gets the repository's rules although it loads no project source.

- **Trusted source only.** The root is resolved in `config_root`: the default-branch checkout for a
  comment turn (never the pull request branch), the workspace for a chat or scheduled turn.
- **Every turn rewrites it.** The file starts with a marker comment. The turn removes a marker file
  it wrote earlier before writing, so a guide that was deleted or switched off does not linger.
- **A user memory Centaur did not write is never touched.** Without the marker, the turn fails
  naming the file (or leaves it alone when the key is off); a self-hosted runner's own
  `$HOME/.claude/CLAUDE.md` is not overwritten.
- **Size cap.** Past `max_bytes` the turn fails with the file name and size; truncating rules
  silently could drop the one that matters.
- **Chat turns.** Claude Code also loads the workspace `CLAUDE.md` through the `project` source, so a
  repository whose guide is `CLAUDE.md` shows it twice there. The copy is the only channel on
  comment turns, and `@file` imports inside the guide resolve against `$HOME/.claude`, not the repo,
  so keep the guide self-contained.
- **HOME.** `prepare` writes to `os.homedir()` of the runner process, the same `$HOME` it uses for
  skills and sessions; the repository sets neither `HOME` nor `CLAUDE_CONFIG_DIR`. That Claude Code
  reads `$HOME/.claude/CLAUDE.md` as user memory under `--setting-sources user` follows from its
  documented memory hierarchy, but the action's launch of `claude` is outside this repository, so it
  is checked live: a scheduled prompt asking the agent to quote the first line of its guide on a
  comment turn.

## Agent turn

1. `prepare` reads the config, reads the thread from the poster (`read`), determines the
   unprocessed messages and the context policy, and writes the prompt to `.centaur-turn/prompt.md`.
   It copies the images attached to the messages the prompt shows (pending ones, plus the earlier
   ones when the history is included) from the session bucket into `.centaur-turn/attachments/`,
   newest 10 at most, and lists each by path under its message; older images are listed as not
   loaded. A failed copy fails the turn.
   When `mcp_servers` is set, it writes `.centaur-turn/mcp.json` (secrets as `${NAME}` references,
   never values) and adds `--mcp-config` to `claude_args`; a referenced secret missing from the
   step's environment fails `prepare` before anything is posted, naming it ([mcp.md](mcp.md)).
   With `chat_tools.scope: chat` and a dispatched thread (chat replies and pull request comment
   turns) it also writes the built-in `centaur-chat` server into `mcp.json`, started as `node
   <dist>/mcp/chat-server-main.js` from the build running `prepare` (the Centaur action's checkout, not
   the workspace), with `${NAME}` references for the poster, OIDC and AWS settings, the turn state
   directory and the two limits, and appends `mcp__centaur-chat__*` to `--allowedTools`. See
   [chat-context.md](chat-context.md#runner-side). The policy checks below cover only `mcp_servers`.
   Before anything else, `prepare` checks the servers against the global policy (the poster's
   `get-mcp-policy`) and `.centaur/mcp-policy.cedar` as it exists on the repository's default
   branch, fetched through the GitHub API (never the checkout), and fails the turn before any other
   poster call when a server is not permitted, no policy exists, a policy is invalid, or one cannot
   be fetched ([Operator policy](mcp.md#operator-policy)).
   The prompt's instructions are the guidance from `instructions/{chat,chat_tools,comment,silence}.md` (`chat_tools` only with the chat context tools on) (or
   the repo's `instructions` overrides in the config, read from the checkout like the persona)
   followed by fixed text in `prompt.ts`: the untrusted-input warning and the structured-output
   fields the workflow parses (`reply`, `ignore`, `pr_title`, ...), which a repo cannot override.
   It outputs the `claude_args` (model and tuning flags, `--allowedTools`, `--json-schema` requiring `reply` (or, for `respond_to: all` threads, `reply` or `ignore: true`; optionally `pr_title`, `pr_body`, and the `pr_action` or `existing_pr_number` target field when enabled, `suspend_for` when approval-required servers are pending), persona
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
   it (`post`, or `start-thread` for scheduled prompts and `/new`; `prepare` records the targets in
   the turn state: one `destination` name with its `platform` per target of the prompt, which the poster resolves to a chat approved for the bot, or the originating thread for `/new`), advances the marker and saves the
   session for `resume` threads. When the agent returned `ignore: true` nothing is posted unless a
   pull request was opened or updated, in which case only its link is posted;  the marker and session are still saved.
   The link reads `Pull request: <url>`, or `Updated pull request: <url>` when `push-existing`
   updated an existing one (it also posts a `<!-- centaur:reply -->` conversation comment there
   with the title and body, leaving the pull request's own title and body alone). When the
   agent's choice fell back, the note adds `Could not update #N (<reason>); opened the usual pull
   request instead.`, with the reason code from `plan-pr` or `push-existing`; it is omitted when no
   pull request was opened.
   The `Open pull request` and `push-existing` steps are `continue-on-error`, so a rejected push or
   pull request (for example a branch that edits `.github/workflows/*` without the permission for it)
   does not fail the job. When one failed and no pull request was opened, `finish` appends `I couldn't
   open the pull request, so the changes were not saved. Details: <run url>.` to the reply, with no
   error text; the marker and session advance as for any answered turn. A comment turn whose push
   fails posts the same note in its marked comment.
   A scheduled prompt with several targets still runs one agent turn: `finish` starts a thread
   per target, in the order of the prompt's `destination` map, and posts the same reply (with the
   same title and pull request link) to each. The first thread that received the reply is the
   primary thread: it takes the pull request link, the marker and the saved session (a `resume`
   prompt has exactly one target, so the session is never shared). Every target is attempted even
   when an earlier one fails; each failure is logged as a warning naming the bot, platform and
   destination only. Once the others are posted and the primary thread's bookkeeping is done,
   `finish` fails the step, listing the targets that did not receive the reply, so
   `notify-failure` runs (a prompt with one target, and `/new`, rethrow the poster's own error instead, unchanged); if every target failed there is no primary thread and nothing else is
   saved. Re-running the job posts to every target again, including those that already received it.
   When `create-pull-request` produced a pull request, `finish` also links it to the thread it
   replied in (for scheduled prompts, the primary thread) with the poster's
   `link-pull-request`, authenticated by the same OIDC token as `register`; a failure is a warning
   and never fails the turn.
   Last, it removes the 👀 reaction (`unreact`) from every message the turn processed, so a message
   that still shows 👀 is still being worked on. A turn that suspends for MCP approval does this
   before its suspend call, which leaves the waiting reaction on the message.
5. On failure (a failed pull request step is not one: see above), `notify-failure` posts a generic notice with the run URL, or, when the agent stopped on `max_budget_usd` (result subtype `error_max_budget_usd` in the action's execution file under `RUNNER_TEMP`), a one-line spending-limit notice, then removes the 👀
   reactions; the marker is not advanced, so the messages are retried on the next turn.

`prepare` records the turn state (bot, thread, mode, pull request and reply target, marker, session
directory, the pending message IDs; IDs only, no content) in `<RUNNER_TEMP>/centaur-turn/state.json`
for `pr-details`, `finish` and `notify-failure` (see [Turn state](#turn-state)). Turns that end in `prepare`
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

### Turn state

Every field of the turn state steers a trusted step, so none of it lives in the workspace, where
the agent could rewrite it: `mode`, `bot`, `threadId`, `pullRequest`, `replyTo`, `start` (a list: one entry per target of a scheduled prompt, each with `thread: persistent` for a persistent prompt, or the single
`fromThreadId` of `/new`) and
`source` pick where `finish` posts and which messages lose their reaction; `marker` (with `markerThreadId`, the thread a persistent scheduled turn read it from), `policy` and
`sessionDirectory` decide what is saved for the next turn; `promptName` and `bot` appear in the
pull request footer. `prepare` writes the file to `<RUNNER_TEMP>/centaur-turn/state.json`
(`turnStateDir` in `src/workflows/turn-state.ts`, falling back to the OS temp directory outside
Actions) with owner-only permissions, and `pr-details`, `finish` and `notify-failure` read it back
from there. They run on the same runner in the same job, so no step output or environment variable
has to carry the path. What the agent needs stays in `.centaur-turn/` in the workspace: `prompt.md`,
`attachments/` and `mcp.json` (secrets only as `${NAME}` references; the chat server entry carries the same references and no thread ID).

The agent's `Read`, `Edit` and `Write` tools are confined to the workspace by Claude Code, so they
cannot reach the runner temp directory. A `Bash` tool in `allowed_tools` runs as the same user as the
workflow and can read or write any file there, including this one. Keep `Bash` out of
`allowed_tools` (or allow only narrow patterns) for bots whose repository is not fully trusted;
moving the file does not protect against an unrestricted shell.

### Choosing the pull request

Two more optional fields choose the pull request a turn targets, each present only when
`pull_requests` in the config enables it: `pr_action` (`update` or `new`, comment turns) and
`existing_pr_number` (a positive integer, chat and scheduled turns). `extractResult` returns them as
`prAction` and `existingPr`; a malformed value fails the reply like any other schema violation, and
`finish` ignores a field that does not fit the turn's mode with a `::warning::` that names no
content.

`prepare` lists the pull requests a chat or scheduled turn may update when `existing` is `bot`:
open pull requests of this repository, not forks, from `centaur/<bot>-<thread key>` branches authored by
`github-actions[bot]`, the 10 most recently updated. When the poster has a `resolve-pull-request` record it
must name the same bot; a missing record is allowed (older pull requests predate linking), and a
poster error excludes the pull request. The prompt gets an "Open pull requests you may update"
section of numbers and fenced titles, noted as data, and the schema gets `existing_pr_number`. With
no candidates, or when GitHub fails (a `::warning::`, never a failed turn), the section, the field
and the "number must be listed" sentence are all omitted. `prepare` needs `GITHUB_REPOSITORY` and
`GITHUB_TOKEN` for this and lists nothing without them. Comment turns list nothing.

`centaur-workflow plan-pr` re-derives the same candidate set from GitHub, never from
the turn state, and checks the agent's `existing_pr_number`, read from the execution
file (`EXECUTION_FILE`) like `pr-details` and `finish` do, against it. With `existing: off` or
without `GITHUB_TOKEN` it plans `thread` without calling GitHub. It reads the config from
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
base and head repositories are both this repository (not a fork), its head branch is
`centaur/<bot>-<thread key>` (optionally followed by `-<run id>-<attempt>`), it was opened by `github-actions[bot]`, and, when the poster has a
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

**Security.** `plan-pr` never reads the turn state, and it is kept out of the workspace anyway
([Turn state](#turn-state)): `plan-pr` re-derives the candidate set from GitHub and the poster, and `existing_pr_number` is read
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
get that; they may also pass `config_root` (a checkout of the default branch) so that the config,
the instructions and the persona are read from the default branch instead of the pull request
branch. This repo, which uses its own actions locally, checks out the default branch into
`.centaur-trusted` and runs `./.centaur-trusted/.github/actions/...`. See
[Trust boundary](pr-comments.md#trust-boundary).

With `comment` set, the action passes `COMMENT_PULL_REQUEST` and `GITHUB_TOKEN` to `prepare`,
`finish` and `notify-failure` (and `CENTAUR_CONFIG_ROOT` to `prepare` and `finish`, so `finish`
reads `pull_requests.comment_new` from the trusted config root, not the pull request branch), and skips `pr-details` and `create-pull-request`. The steps differ
from a chat turn as follows:

- `prepare` (comment mode) resolves the thread through the poster (masking the raw thread ID),
  answers every comment from an author whose `author_association` is in `pull_requests.comment_authors` (see
  [pr-comments.md](pr-comments.md#whose-comments-are-heard)) newer than the agent's latest marked comment, and records
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
`<prompt>-<run id>` for the branch. A scheduled workflow's group comes from `resolve-schedule`
([Persistent scheduled threads](#persistent-scheduled-threads)).

### Context policies

| Policy | Prompt contains | Session |
|---|---|---|
| `fresh` | Pending messages only | none |
| `transcript` | Earlier messages in the thread, then the pending ones | none |
| `resume` | Pending messages only when a session exists; otherwise as `transcript` | `sessions/<bot>/<thread>/<session_id>.jsonl` in S3, restored to `~/.claude/projects/<escaped cwd>/` and saved back after the turn |

The thread's policy is the latest `/resume` or `/transcript` a human used in the thread, else the
policy stored on the thread (`read` returns it as `policy`), else `context.default`. `start-thread`
stores a scheduled prompt's `context` on each thread it starts, so replies there keep the prompt's
policy; threads started before it was stored, and `/new` threads, use `context.default`. A thread
shared by two prompts uses the latest run's policy.

### Transcript budget

`prepare` fits the earlier messages of a `transcript` turn (and of a `resume` turn that has to fall
back to the transcript, and of a pull request comment turn) into `context.transcript_max_chars`
characters of message text ([config.md](config.md#context)), so a long thread or one huge message
cannot crowd out the persona, the repo and the agent's own work. The poster's `read` returns up to
100 stored messages; the bound is applied in `prepare` (`src/workflows/transcript-budget.ts`).

- **Characters, not tokens.** The budget counts characters of message text. It needs no tokenizer
  and sends nothing to any vendor. The default of 100,000 is about 25k tokens of English text.
- **Fill.** Messages are taken newest first until the budget is spent, then shown oldest first. The
  fill stops at the first message that does not fit, so the shown messages are the newest unbroken
  run. The pending messages are always shown in full and are not charged to the budget.
- **Oversized message.** An earlier message longer than half the budget is cut to its first chunk
  of `splitTextMaxChars(text, budget / 2)` (`src/workflows/split-text.ts`) and ends with a marker,
  `[message shortened: first N of M characters shown]`. It is shortened, never dropped, and the
  marker is not charged to the budget.
- **Omission note.** When messages are left out, the transcript section starts with a line saying
  how many earlier messages are omitted and not part of this turn. With the
  [chat context tools](chat-context.md) enabled it adds how to fetch them (`read_thread` on
  `thread-0` with a `before` cursor); without them it says they are not available this turn and the
  agent should ask the user for anything it needs. The note is fixed text in `prompt.ts`.
- **The marker is unaffected.** Pending messages and the last-processed marker are computed from
  the full stored transcript before any trimming.
- **No text in the job log.** The bound never logs message text or the cut content
  ([Keeping content out of GitHub](#keeping-content-out-of-github)).

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
