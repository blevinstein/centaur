# Self-development bot

Status: **slice 1 (the repo side) is built; slices 2 to 5 are open**. A bot that develops this repository: the maintainer asks it for a
change in Slack or Telegram, or a scheduled prompt picks the next task, and the agent runs shell
commands, reads the web, verifies its work and opens a pull request. Terms (turn, poster, root) are in
[workflows.md](../workflows.md); the sub-folder layout it follows is in
[two-bot-test.md](two-bot-test.md).

## Problem

The turn pipeline already does everything except the development work itself. A chat message or a
scheduled prompt dispatches a Claude Code turn on a runner with this whole repository checked out;
`finish` opens a `centaur/<bot>-<thread>` pull request and replies in the thread. What the live
bots lack is tools: `centaur-slack` allows `Read,Glob,Grep,Write,Edit` and a read-only GitHub MCP,
so it cannot run `yarn verify`, install a dependency or look up documentation, and its 30 turns and
30-minute job are sized for chat.

## Design

A third bot in this repository, `centaur-dev`, in `apps/centaur-dev`. It is separate from
`centaur-slack` because that bot is `respond_to: all` in a shared test channel, where every approved
participant (and every pasted page) would steer a shell.

### Config

```yaml
bot: centaur-dev
platforms:
  slack:
    respond_to: mention
  telegram:
    respond_to: mention
context:
  default: transcript
repository_instructions:
  include_repo_root: true
  max_bytes: 65536
provider: anthropic
model: opus
allowed_tools: "Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch"
max_turns: 150
max_budget_usd: 10
persona: .centaur/persona.md
prompts:
  next-task:
    destination: { slack: centaur-dev }
```

- `execution` stays at the default, `pull_request`. Every change to this repository is reviewed;
  `direct` is not offered for this bot (see [Decisions](#decisions)).
- `pull_requests.existing` keeps its default, `bot`, which lets a follow-up message in the same thread update the pull request
  it opened ("fix the lint error") instead of opening another.
- No `mcp_servers`, so no MCP secrets are in the agent's environment. GitHub reads go through `gh`
  and the job token instead (see [Accepted risk](#accepted-risk)).
- The model, turn cap and budget are starting values; the first real runs set them.

### Instructions

Sub-folder bots default to `repository_instructions.include_repo_root: false`, so the config opts in
(`include_repo_root: true`) to install the repository's top-level `AGENTS.md` ahead of
`apps/centaur-dev/AGENTS.md` on every turn ([Repository instructions](../workflows.md#repository-instructions)),
with `max_bytes: 65536` because the top-level `AGENTS.md` is already over 23 KB of the 32 KB default.
The bot therefore follows the same conventions as any other agent here, and `apps/centaur-dev/AGENTS.md`
adds only what is specific to the bot:

- Run `yarn verify` before finishing and state the result in `pr_body`. Pull requests opened with the
  job's `GITHUB_TOKEN` trigger no workflows, so nothing else tests the change before review.
- Never run `git commit`, `git push` or `gh pr create`; the harness opens the pull request.
- Changes under `.github/workflows/` cannot be pushed with the job token (it has no `workflows`
  permission); describe such a change in the reply instead of making it.
- Run `bd` only for reading if it is installed; task status changes are the maintainer's.

The persona sets the voice: terse progress, the outcome first, the pull request link last.

### Workflows

- `centaur-dev-message.yml`: the thin caller of `centaur-turn.yml`, filtered on
  `client_payload.bot == 'centaur-dev'`, like `centaur-test-2-message.yml`.
- `centaur-turn.yml` gains a `timeout_minutes` input (default `30`, used as the job's
  `timeout-minutes`); the dev caller passes `90`.
- `centaur-register.yml`: `apps/centaur-dev` in the matrix and in `paths`.
- `centaur-dev-next-task.yml`: the scheduled workflow from
  [Consumer workflows](../workflows.md#consumer-workflows) with `prompt_name: next-task`, a weekday
  cron and `workflow_dispatch`. Built after the chat path has been used by hand.

The runtime is already there: `setup-runtime` runs `yarn install --immutable && yarn build` in the
action's checkout, which for this repository is the workspace, and `ubuntu-latest` has Docker for
the DynamoDB Local container `yarn test` starts. `yarn lint:cfn` runs cfn-lint through `uvx`, and CI installs `uv` with `astral-sh/setup-uv`.

### The `next-task` prompt

Read `TODO.md`, pick one open item that is not labeled **[HUMAN ACTION]** or **[HUMAN APPROVAL]** and
has no open `centaur/centaur-dev-*` pull request, implement it, verify it and open a pull request.
Reply with the item, what changed and the verification result; if nothing is suitable, say so and
change nothing. One item per run.

`TODO.md` rather than `bd ready`: Beads needs the `bd` binary and a Dolt pull from `refs/dolt/data` on
the runner. Moving the prompt to Beads is a later slice.

## Accepted risk

`Bash` runs as the workflow user, so it reaches everything the job holds, which the docs already warn
about ([Turn state](../workflows.md#turn-state)). For this bot that is:

| Reachable from `Bash` | Consequence if the agent is steered |
|---|---|
| AWS role credentials exported by `setup-runtime` | Anything the Centaur role may do, including calling the poster as this repository |
| The OIDC credentials file and the turn state in `$RUNNER_TEMP` | Post as the bot elsewhere; redirect where `finish` posts |
| The job `GITHUB_TOKEN` (persisted in the git config by `actions/checkout`, `contents: write`, `pull-requests: write`) | Push to any unprotected branch, bypassing the pull request flow; comment on or edit pull requests |
| `ANTHROPIC_API_KEY` in the environment | Spend on the key |

`WebFetch` and `WebSearch` bring untrusted text into the same session, which is the prompt-injection
path [plan.md](../plan.md#security) warns about. For the first version this is accepted, on these
conditions:

- **Admin only.** Only the maintainer is approved for `centaur-dev`, through a direct message or a
  private chat with no one else in it. Approving a shared chat approves everyone in it.
- **Mention only.** `respond_to: mention` on both platforms, so no unaddressed message runs a turn.
- **Review is the gate.** Pull request mode; `main` is protected so a stray `git push` with the job
  token cannot land there. Merging deploys nothing: the Lambda changes only on `yarn deploy-prod`,
  and changes to the composite actions take effect on the next turn of every bot in this repository,
  which is why they need the same review as any other change.
- **Spend caps.** `max_budget_usd` per turn and a spend limit on the Anthropic key.

### Hardening, later

In order of cost, each tracked as its own task:

1. **Remove credentials from the agent step.** `persist-credentials: false` on the checkout, and
   clear the AWS variables and `GITHUB_MCP_TOKEN` in the `Run agent` step's `env`. `push-existing`
   and `push-direct` push with plain `git` on the persisted credential, so they would need the token
   configured after the agent step. Leaves the files in `$RUNNER_TEMP` reachable.
2. **Claude Code's sandbox.** Filesystem and network allowlists for `Bash` through `--settings`. Needs
   a live check that `claude-code-action` honors it, and an exception to the rule in
   [skills-rules.md](../skills-rules.md) that `prepare` passes no `--settings`.
3. **Split the job.** The agent runs in a job with read-only permissions and only the model key; it
   hands the diff and its output file to a trusted job that runs `pr-details`, `plan-pr`, the push and
   `finish`. This is the real fix and a sizable change to `.github/actions/turn/action.yml`.

## Implementation slices

1. **Repo side** (built). `apps/centaur-dev/.centaur/config.yml`, `persona.md`, `prompts/next-task.md`,
   `apps/centaur-dev/AGENTS.md`; `centaur-dev-message.yml`; the `timeout_minutes` input; the register
   matrix; `test/self-consumer.test.ts` validates the config. The config must not reach `main` before
   the deployed Lambda parses it (`repository_instructions.include_repo_root` is already deployed).
2. **Maintainer setup.** The same steps as for `centaur-test-2`
   ([two-bot-test.md](two-bot-test.md#step-2-the-second-bot)): create the Slack app and Telegram bot,
   `centaur bot add`, merge slice 1 so `register` binds the bot, nudge the receiver, and approve only
   the maintainer's private chat on each platform.
3. **First runs.** Ask for a small, known change (a `TODO.md` item with a clear test) and tune
   `model`, `max_turns`, `max_budget_usd` and the timeout from the run.
4. **Scheduled `next-task`.** The workflow and its destination.
5. **Hardening.** The three items above.

## Test plan

- `test/self-consumer.test.ts`: the config parses and binds `centaur-dev`.
- A chat turn asking for a one-line change: a pull request on `centaur/centaur-dev-<key>` whose body
  states the `yarn verify` result, and a reply with the link.
- A follow-up in the same thread updates that pull request instead of opening another.
- A request to edit a workflow file: the reply explains the limitation and no push fails.
- `workflow_dispatch` of `centaur-dev-next-task.yml`: a new thread naming the picked item and a pull
  request, or a reply that nothing was suitable.

## Decisions

- **A new bot, not `centaur-slack`.** Its access list, chats and `respond_to` differ, and the existing
  bot stays a low-privilege smoke test.
- **Accept the credential exposure for v1.** Conditions above; the hardening items are tracked, not
  required to start.
- **No `direct` mode.** This repository holds the bot's own harness and infrastructure; unreviewed
  self-modification is out of scope even with branch protection.

## Open questions

- Does `opus` with 150 turns fit the 90-minute job for a typical `TODO.md` item, or should the
  scheduled prompt cap itself to smaller items?
