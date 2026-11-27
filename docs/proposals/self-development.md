# Self-development bot

Status: **slices 1 and 4 (the repo side and the scheduled workflow) are built; slices 2, 3 and 5 are open**. A bot that develops this repository: the maintainer asks it for a
change in Slack, or a scheduled prompt picks the next task, and the agent runs shell
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
- `centaur-dev-pr-comment.yml`: the thin caller of `centaur-comment-turn.yml` for review comments on `centaur/centaur-dev-*` pull requests, with `bot: centaur-dev`, `root: apps/centaur-dev` and `timeout_minutes: 90`; `centaur-comment-turn.yml` gains the same `timeout_minutes` input (default `30`). `resolve` takes the bot from the poster's stored thread record, so the other bots' comment callers skip these pull requests and this one skips theirs.
- `centaur-register.yml`: `apps/centaur-dev` in the matrix and in `paths`.
- `centaur-dev-next-task.yml`: the scheduled workflow from
  [Consumer workflows](../workflows.md#consumer-workflows) with `prompt_name: next-task`, a weekday
  cron and `workflow_dispatch`; its concurrency group comes from `resolve-schedule`, and the job timeout is `90` like the message caller. A failed run posts through the in-job `notify-failure`; there is no `notify-timeout` job because a scheduled run has no dispatch payload to post to.

The runtime is already there: `setup-runtime` runs `yarn install --immutable && yarn build` in the
action's checkout, which for this repository is the workspace, and `ubuntu-latest` has Docker for
the DynamoDB Local container `yarn test` starts. `yarn lint:cfn` runs cfn-lint through `uvx`, and `ubuntu-latest` does not list `uv` in its image, so CI and `setup-runtime` install it with `astral-sh/setup-uv` (the same pinned ref).

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
- **Mention only.** `respond_to: mention` on Slack, so no unaddressed message runs a turn.
- **Review is the gate.** Pull request mode; `main` is protected so a stray `git push` with the job
  token cannot land there. Merging deploys nothing: the Lambda changes only on `yarn deploy-prod`,
  and changes to the composite actions take effect on the next turn of every bot in this repository,
  which is why they need the same review as any other change.
- **Spend caps.** `max_budget_usd` per turn and a spend limit on the Anthropic key.

### Residual exposure

Every git call in the push steps (`gitIn`, `src/workflows/push.ts`) overrides, on the command
line, the workspace config an agent could plant to run code with the push-time token: `core.hooksPath`
(`/dev/null`), `core.fsmonitor`, `core.sshCommand`, `credential.helper` and `commit.gpgsign`.

The rest is accepted on the conditions above, and none of it is planned work:

- **Credentials in the agent step.** The checkout persists the job token, the AWS variables and the
  files in `$RUNNER_TEMP` are reachable, and `claude-code-action` runs on the same token. A separate
  fine-grained token for the action, or moving the push and `finish` into a trusted job and leaving
  the agent a read-only job with only the model key, would close it.
- **Remaining git config.** `url.<base>.insteadOf`, `http.*` and other keys that redirect the push,
  and filter drivers named by a committed `.gitattributes`, are not overridden. The same job split
  closes them.
- **`Bash` itself.** Sandboxing it (Claude Code's filesystem and network allowlists through
  `--settings`) would limit most of the above; see [Hardening 2](#hardening-2-sandbox-bash), which
  is evaluated but not built.

## Hardening 2: sandbox `Bash`

Status: evaluated from the documentation only; **not verified on a runner**. Nothing here is built.
The live check below is the gate, and the rule exception needs the maintainer's approval.

Sources (raw pages, read 2026-11-27): [Sandboxing](https://code.claude.com/docs/en/sandboxing.md),
[Settings reference](https://code.claude.com/docs/en/settings-reference.md),
[Settings](https://code.claude.com/docs/en/settings.md), and the action's
[`parse-sdk-options.ts`](https://github.com/anthropics/claude-code-action/blob/main/base-action/src/parse-sdk-options.ts),
[`docs/usage.md`](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md) and
[`docs/security.md`](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md).

### What the sandbox protects

An operating-system boundary around every `Bash` command and the processes it starts
([What the sandbox restricts](https://code.claude.com/docs/en/sandboxing.md#what-the-sandbox-restricts)):

| Surface | Inside the sandbox | Closes (from the table under [Accepted risk](#accepted-risk)) |
|---|---|---|
| Writes | The working directory, a per-user temp directory and `--add-dir` directories only. Settings files, `.claude/skills`, `.mcp.json`, `.git/hooks`, `.git/config` and most of `~/.claude` stay write-denied ([Protected paths](https://code.claude.com/docs/en/sandboxing.md#protected-paths)) | A planted git config or hook, and the user-scope settings file the sandbox itself and the tool gate depend on. This covers most of the "Remaining git config" bullet above; confirm in the live check |
| Reads | Most of the machine by default, credentials included. `sandbox.filesystem.denyRead` and `sandbox.credentials.files` narrow it | The OIDC credentials file and the turn state in `$RUNNER_TEMP`, once listed |
| Environment | Inherited by default; `sandbox.credentials.envVars` with `"mode": "deny"` unsets named variables for sandboxed commands only ([Protect credentials](https://code.claude.com/docs/en/sandboxing.md#protect-credentials)) | `ANTHROPIC_API_KEY` and the AWS variables from `Bash` |
| Network | No direct route; the commands reach only hosts the proxy allows. `network.strictAllowlist` refuses everything else without prompting ([Network isolation](https://code.claude.com/docs/en/sandboxing.md#network-isolation)) | Exfiltration and calls to the poster or AWS from `Bash` |

The job `GITHUB_TOKEN` is the exception: `actions/checkout` persists it in the workspace `.git/config`,
which a sandboxed `git` must read, so denying the variable does not hide it. With `github.com`
allowed, a steered agent can still push with it (to any unprotected branch, as in the table above),
so the sandbox narrows the token's reach to the allowed hosts and does not remove it. Removing the
persisted credential (checkout `persist-credentials: false`, with `finish` pushing through its own
credential) is a separate change that this evaluation did not look at.

### How it is turned on

The sandbox is off by default and is enabled by `sandbox.enabled` in any settings source
([Settings reference](https://code.claude.com/docs/en/settings-reference.md#sandbox-enabled)).
The action reaches it two ways, and only the second is suitable:

- The action's `settings` input is merged into `~/.claude/settings.json` (user scope) by
  `setup-claude-code-settings.ts`. The turn action uses no `settings` input, and the sandbox would
  not be admin-required from there.
- `--settings <file-or-json>` in `claude_args` is passed through to the CLI untouched (the action
  forwards unknown flags as `extraArgs`, `parse-sdk-options.ts`). It ranks above user, project and
  local settings and below managed ([Settings precedence](https://code.claude.com/docs/en/settings.md#settings-precedence)).
  Setting `allowUnsandboxedCommands: false` through it makes the sandbox **admin-required**
  (Claude Code 2.1.285 or later), so the repository's `.claude/settings*.json` can no longer add
  `excludedCommands`, `allowedDomains` or `allowWrite`
  ([Repository settings under an admin-required sandbox](https://code.claude.com/docs/en/sandboxing.md#repository-settings-under-an-admin-required-sandbox)).

`prepare` already builds one `--settings` file, for the tool gate (`toolGateSettings`,
`src/workflows/tool-gate.ts`), together with `--setting-sources user`. The docs do not say whether
repeating `--settings` merges the values, so the sandbox keys go into that same file and `prepare`
writes it whenever either feature is on. Because `--setting-sources user` already applies, the
workspace's own settings, which a pull request branch controls on a comment turn, are not read, and
the docs say excluded sources' `sandbox.filesystem` and `credentials` entries are ignored
([Configure sandboxing](https://code.claude.com/docs/en/sandboxing.md#configure-sandboxing)).

### Proposed settings

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["<RUNNER_TEMP>", "~/.aws", "~/.config/gh"]
    },
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["github.com", "api.github.com", "registry.yarnpkg.com", "registry.npmjs.org"]
    },
    "credentials": {
      "envVars": [
        { "name": "ANTHROPIC_API_KEY", "mode": "deny" },
        { "name": "AWS_ACCESS_KEY_ID", "mode": "deny" },
        { "name": "AWS_SECRET_ACCESS_KEY", "mode": "deny" },
        { "name": "AWS_SESSION_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

- `failIfUnavailable` makes a runner without a working sandbox fail the turn instead of running
  `Bash` unsandboxed, which is the documented default
  ([Settings reference](https://code.claude.com/docs/en/settings-reference.md#sandbox-failifunavailable)).
  A failure that happens after startup refuses each command instead of exiting.
- `allowUnsandboxedCommands: false` removes the `dangerouslyDisableSandbox` retry; with it on, an
  allow rule such as `Bash` in `allowed_tools` would approve the unsandboxed retry with no prompt
  ([The unsandboxed retry escape hatch](https://code.claude.com/docs/en/sandboxing.md#the-unsandboxed-retry-escape-hatch)).
  This matters here because `allowed_tools` lists `Bash`.
- `<RUNNER_TEMP>` is a placeholder: `prepare` substitutes the runner's literal temp path (the docs
  give no environment-variable expansion in these lists). The turn state also holds the
  tool-gate policy, so denying reads of it keeps the policy private from `Bash`.
- The domain list is a starting guess from what `yarn install`, `gh` and git over HTTPS need. It is
  not derived from a run; the live check records the hosts the sandbox actually refuses and the
  list is adjusted from that. Wildcards and ports are supported.
- No `excludedCommands`, no `allowWrite`, no `allowNestedUserNamespaces`, no `filesystem.disabled`;
  each one reopens a hole (see Risks).
- `autoAllowBashIfSandboxed` is not set: `allowed_tools` already approves `Bash`.
- Not settled: whether `gh` can authenticate with `GITHUB_TOKEN` denied. The settings keep the
  variable so `gh` works, and the persisted copy in `.git/config` is reachable anyway. The `mask`
  mode would hide the value, but it needs `network.tlsTerminate` (experimental), and the docs list
  that key as "User or managed", without saying whether `--settings` counts.

### Runner prerequisites

- Linux needs `bubblewrap` and `socat` ([Set up Linux and WSL2](https://code.claude.com/docs/en/sandboxing.md#set-up-linux-and-wsl2));
  `sudo apt-get install bubblewrap socat` on Ubuntu. The runner image README read (Ubuntu 24.04, image `20261122.23.1`) does not list them, so install
  them before the agent step (for example in `setup-runtime`). `sudo apt-get` is not used there
  today.
- The optional seccomp filter (`npm install -g @anthropic-ai/sandbox-runtime`) adds Unix domain
  socket blocking. Without it the sandbox starts, with that one protection missing.
- Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns`), which stops `bwrap`; Claude Code reports it
  since 2.1.310 ([Ubuntu's AppArmor restriction stops bubblewrap](https://code.claude.com/docs/en/sandboxing.md#ubuntus-apparmor-restriction-stops-bubblewrap)).
  The runner-images repository has an issue about the restriction breaking `unshare` on
  `ubuntu-24.04` ([actions/runner-images#10443](https://github.com/actions/runner-images/issues/10443)),
  with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` as the workaround people
  use. Whether the current hosted image has it on **cannot be determined from the docs**; the live
  check reads the value. The narrower fix is the AppArmor profile for `/usr/bin/bwrap` the docs give
  (needs `sudo tee` and `systemctl reload apparmor`); the sysctl lifts the restriction for every
  program on the runner.
- Claude Code must be 2.1.285 or later for the admin-required semantics, 2.1.246 or later for
  `--setting-sources` to drop excluded sources' sandbox entries, and 2.1.310 or later for the
  AppArmor message. The tool-gate evidence was gathered on 2.1.332; the live check prints the
  version the action installs.
- Running as a self-hosted or containerized runner (a job `container:`) would need
  `enableWeakerNestedSandbox` ([Bubblewrap fails to start inside a container](https://code.claude.com/docs/en/sandboxing.md#bubblewrap-fails-to-start-inside-a-container)),
  which weakens the boundary. Hosted `ubuntu-latest` is not a container job, so it is not needed.
- Whether the sandbox applies in the action's non-interactive (SDK/`-p`) sessions is **not stated**
  in the pages read; they describe `/sandbox` and interactive prompts. The live check answers it.

### Risks and what it does not cover

- **File tools.** `Read`, `Write`, `Edit`, `Glob` and `Grep` follow permission rules, not the
  sandbox; `denyRead` does not stop `Read`
  ([What runs outside the sandbox](https://code.claude.com/docs/en/sandboxing.md#what-runs-outside-the-sandbox)).
  `allowed_tools` grants `Write` and `Edit` for this bot, so a steered agent can still reach
  whatever those rules allow, including files the sandbox write-denies. Whether they can write
  outside the working directory in a headless run is not covered by the pages read.
- **`WebFetch` and `WebSearch`.** Run outside the sandbox; `allowedDomains` does not limit
  `WebFetch`. This is the injection path and it stays open. Denying them is a `config` decision, not
  a sandbox one.
- **MCP servers.** Local (stdio) MCP servers and hooks run with full access. `centaur-dev` declares
  none, but the action sets `enableAllProjectMcpServers: true` in the user settings, and the docs
  read do not say whether `--setting-sources user` also stops a workspace `.mcp.json` from loading;
  verify, and treat a project `.mcp.json` as outside the sandbox. A server that `mcp_servers` adds
  runs unsandboxed too.
- **Commands that leave the sandbox.** `excludedCommands` run with no filesystem or network limit,
  and a script or file the agent can write may be run through them
  ([Run commands outside the sandbox](https://code.claude.com/docs/en/sandboxing.md#run-commands-outside-the-sandbox-with-excludedcommands)).
  This is the main cost for this bot: `yarn test` starts Docker for DynamoDB Local, and the docs say
  `docker` is incompatible with the sandbox, and that on Linux a sandboxed command's `localhost` is
  private ([A command fails to reach a server on localhost](https://code.claude.com/docs/en/sandboxing.md#a-command-fails-to-reach-a-server-on-localhost)).
  So `yarn verify` and `yarn test` cannot pass inside the sandbox, and excluding them gives the
  agent an unsandboxed path through any test file it writes. Candidates, none tested: have the
  agent run only lint, typecheck and build and leave tests to CI on the pull request; start
  DynamoDB Local in a trusted step before the agent and give `Bash` a route to it
  (`allowedDomains` takes an IP such as `127.0.0.1:8000`, but the SDK must go through the proxy,
  which the AWS SDK for Node does not do by default); or accept `excludedCommands: ["yarn test *"]`.
  This changes the instruction that the bot runs `yarn verify` before finishing.
- **Domain fronting.** The proxy filters by hostname and does not inspect TLS
  ([Security limitations](https://code.claude.com/docs/en/sandboxing.md#security-limitations)); a broad
  entry such as `github.com` is an exfiltration path (a push to any repository with the persisted
  token).
- **Unix sockets and `unshare`.** Leave `allowUnixSockets` and `allowNestedUserNamespaces` unset; the
  docs say the second turns off the security boundary.
- **Everything after the agent.** `finish`, `audit-tool-calls` and the push steps run outside the
  sandbox, and `claude-code-action` itself runs on the job token. The agent's workspace edits are
  read by them, as they are today.
- **Native tooling that breaks.** The docs name `watchman` and `docker` as incompatible; anything
  that needs a host not in the list fails with a refusal naming the host, which the agent can read.
  A tighter list costs retries and turns.
- **Fail-open default.** Without `failIfUnavailable`, a runner that cannot start `bwrap` silently runs
  everything unsandboxed. The settings above set it.

### The rule exception (needs maintainer approval)

[skills-rules.md](../skills-rules.md) states, in "What the code does today", that `claude_args`
carries no `--settings` and that the turn passes no `settings` input. That row is already out of
date for turns with `mcp_servers`, where `prepare` passes `--settings` and `--setting-sources user`
for the tool gate (AGENTS.md, [mcp.md](../mcp.md)). The narrowest exception, proposed wording:

> `--settings` is passed only as one file that `prepare` writes into the turn state directory,
> outside the workspace; its content comes from Centaur code and the config, never from repository
> files or the pull request, and it is always paired with `--setting-sources user`. It carries only
> the tool-gate hook and the `sandbox` keys, and the action's `settings` input stays unused.

Why this is the narrowest form: a file in the state directory is out of the workspace, so a pull
request cannot change it. A sibling `settings` input would write user scope instead and does not make
the sandbox admin-required.

This evaluation did not change `docs/skills-rules.md`; adopting the wording, and updating that row,
is the maintainer's decision.

### Live check procedure

Run it once, on an `experiment/*` branch with a `workflow_dispatch` stub on `main`, as AGENTS.md
describes (`gh workflow run sandbox-check.yml --ref experiment/sandbox-check`). The workflow is one
job on `ubuntu-latest` with `permissions: contents: read`, a checkout, and:

1. **Prerequisites.** Print `lsb_release -ds`, `sysctl kernel.apparmor_restrict_unprivileged_userns`
   and `which bwrap socat`. Then `sudo apt-get install -y bubblewrap socat`. If the sysctl prints
   `1`, install the AppArmor profile from the docs (or, for the check only, set it to `0`) and record
   which fix was needed.
2. **Agent step.** `anthropics/claude-code-action@v1`, a throwaway `ANTHROPIC_API_KEY`, `env` of
   dummy `AWS_SECRET_ACCESS_KEY=probe-secret`, a prompt that asks for the probes below verbatim and
   to report each result, and
   `claude_args: --allowedTools "Bash" --max-turns 12 --setting-sources user --settings '<the JSON above>'`.
3. **Report.** Print the tool results from `steps.agent.outputs.execution_file` with `jq`.

Probes the agent runs, and the expected observable result if the action honors the settings:

| # | Probe | Expected with the sandbox | Without it |
|---|---|---|---|
| 1 | `touch ~/sandbox-probe` | `Read-only file system` | succeeds |
| 2 | `curl --noproxy '*' -sS https://example.com` | `Could not resolve host` | returns HTML |
| 3 | `curl -sS https://example.com` (through the proxy, host not listed) | refused, with the host named in the result | returns HTML |
| 4 | `curl -sS -o /dev/null -w '%{http_code}' https://api.github.com` | `200` or `401`, not a refusal | same |
| 5 | `echo "${AWS_SECRET_ACCESS_KEY:-unset}" "${ANTHROPIC_API_KEY:-unset}"` | `unset unset` | both set |
| 6 | `echo x >> .git/config` | denied | succeeds |
| 7 | `echo x >> ~/.claude/settings.json` | denied | succeeds |
| 8 | `ls "$RUNNER_TEMP"` | denied or empty | listed |
| 9 | Retry probe 1 with `dangerouslyDisableSandbox: true` | refused | succeeds |
| 10 | `git status && yarn install --immutable` | succeeds, or refusals that name hosts to add | succeeds |
| 11 | `docker ps` and the DynamoDB test path | fails, as the risks section expects | succeeds |

Then a negative control: repeat the run after `sudo apt-get remove -y bubblewrap` (or without the
install step). Expected: the action fails at startup because of `failIfUnavailable`; if the run
instead proceeds and probe 1 succeeds, the setting is not honored and the proposal stops here.

Record: the Claude Code version, the sysctl value, which fix made `bwrap` start, the hosts that
probe 10 needed, whether probes ran in a non-interactive session at all (probes 1 to 3 failing as
expected answer that), and whether a workspace `.mcp.json` server started. If probe 1 succeeds, check that the action log shows `--settings` on the command line and that
the JSON is valid.

If the run passes, the follow-ups are: `prepare` merges the sandbox keys into `toolGateSettings`
(a code change with a test that the sandbox keys and the hook coexist and that the settings path
stays under the state directory), `setup-runtime` installs the packages, `docs/skills-rules.md`
gets the exception above, and `docs/mcp.md` and `AGENTS.md` mention the shared settings file.

## Implementation slices

1. **Repo side** (built). `apps/centaur-dev/.centaur/config.yml`, `persona.md`, `prompts/next-task.md`,
   `apps/centaur-dev/AGENTS.md`; `centaur-dev-message.yml`; the `timeout_minutes` input; the register
   matrix; `test/self-consumer.test.ts` validates the config. The config must not reach `main` before
   the deployed Lambda parses it (`repository_instructions.include_repo_root` is already deployed).
2. **Maintainer setup.** The same steps as for `centaur-test-2`
   ([two-bot-test.md](two-bot-test.md#step-2-the-second-bot)): create the Slack app (`centaur-dev` has no Telegram bot),
   `centaur bot add`, merge slice 1 so `register` binds the bot, nudge the receiver, and approve only
   the maintainer's private chat.
3. **First runs.** Ask for a small, known change (a `TODO.md` item with a clear test) and tune
   `model`, `max_turns`, `max_budget_usd` and the timeout from the run.
4. **Scheduled `next-task`** (built). `centaur-dev-next-task.yml`; the destination is the `centaur-dev` Slack name, bound by slice 2 (approving the maintainer's chat, or `centaur destination set`). Do not enable it before slice 2.

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
- **Accept the credential exposure for v1.** Conditions above; the residual exposure is
  accepted, not scheduled for hardening.
- **No `direct` mode.** This repository holds the bot's own harness and infrastructure; unreviewed
  self-modification is out of scope even with branch protection.

## Open questions

- Does `opus` with 150 turns fit the 90-minute job for a typical `TODO.md` item, or should the
  scheduled prompt cap itself to smaller items?
