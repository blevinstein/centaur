# Centaur rooted in a sub-folder

Status: **proposal**, not built on `main`. This document is the plan behind the TODO item "Support for
centaur in a sub-folder". It builds on [config.md](../config.md#location) and
[workflows.md](../workflows.md).

## Problem

A monorepo may want its Centaur config, prompts, persona, instructions, consumer skills and agent
guidance (`AGENTS.md`) under a sub-folder (say `apps/garden/`) instead of the repo root, and may want
more than one bot, one per sub-folder. Today everything Centaur reads is resolved against the
repository root, so the only layout that works is `.centaur/` or `.centaur.yml` at the top level.

## What assumes the repo root

| Where | Assumption |
|---|---|
| `src/workflows/config-file.ts` (`CONFIG_FILES`, `findConfigFile`, `readConfigText`) | Looks for `.centaur/config.yml` and `.centaur.yml` directly under the directory it is given; every caller passes the workspace or `CENTAUR_CONFIG_ROOT`. `configRepoRoot` already derives a root from a config path, so the CLI half is nearly there. |
| `src/workflows/cli.ts` (`workspace()`, `CENTAUR_CONFIG_ROOT`) | `prepare`, `finish`, `plan-pr`, `register` and the comment-turn `resolve` read the config at `CENTAUR_CONFIG_ROOT \|\| workspace()`. |
| `src/config/schema.ts` (`repoPath`, `persona`, prompt `file`, `instructions`) | Paths are "relative to the repo root"; defaults are `.centaur/persona.md` and `.centaur/prompts/<name>.md`. |
| `src/workflows/prepare.ts` | Prompt files are read from `join(deps.workspace, prompt.file)`; `CONSUMER_SKILLS_DIR` is `.claude/skills` under `configRoot`; the persona is `join(configRoot, config.persona)` and passed to `claude_args` as `config.persona` (relative to the agent's cwd) or an absolute path when `config_root` is set. |
| `src/workflows/instructions.ts` (`loadInstructions`) | Joins override paths onto the directory it is given. |
| `src/workflows/mcp-policy-check.ts` (`MCP_POLICY_FILE`) | Fetches `.centaur/mcp-policy.cedar` from the default branch by repo-root path. The CLI (`src/cli/commands/config.ts`) reads the same constant next to the config. |
| `.github/workflows/centaur-register.yml` and `docs/workflows.md` | The `paths` filter lists `.centaur.yml` and `.centaur/config.yml` only. |
| `.github/workflows/centaur-pr-comment.yml` | `config_root` is the whole default-branch checkout (`.centaur-trusted`), so the config is again found at its top. |
| `src/workflows/push.ts`, `push-existing.ts`, `turn/action.yml` | `git add --all` and `create-pull-request` act on the whole workspace; `.centaur-turn` and `.centaur-trusted` are excluded at the workspace top. |
| The agent's working directory | `claude-code-action` runs in `GITHUB_WORKSPACE`. Session storage (`sessionDirectory`) is keyed on that path, and Claude Code loads `CLAUDE.md` from the working directory upward. |
| `docs/config.md`, `docs/onboarding.md`, `docs/guide-*.md` | State the root-relative rule and the two config locations. |

What does not assume the root: PR branch names (`centaur/<bot>-<thread key>`, `src/workflows/prepare.ts`
and `isThreadBranch` in `src/workflows/resolve.ts`) carry no paths; the poster, receiver and registry
key on the bot name, and a bot is bound to a repository (`bots/<bot>/repo`), not to a directory; the
concurrency group already includes the bot name. The GitHub Actions workflows must stay in
`.github/workflows/` at the repo root (GitHub ignores any others), so a sub-folder cannot own its
workflow files, only parameterize them.

## Design

### A `root` input on each action that reads the config

Add a consumer-controlled directory, `root`, relative to the repository root and defaulting to `.`.
Everything that today is "the repo root" for Centaur's own files becomes `<root>`:

- Config: `<root>/.centaur/config.yml` or `<root>/.centaur.yml`.
- Config-relative paths (`persona`, `instructions.*`, prompt `file`, defaults under `.centaur/`):
  relative to `<root>`.
- Consumer skills: `<root>/.claude/skills`.
- MCP policy: `<root>/.centaur/mcp-policy.cedar`, still fetched from the default branch.
- Register `paths` filter: `<root>/.centaur.yml`, `<root>/.centaur/**`.

Delivery is an optional `root` input on each action that reads the config (`register`, `turn`,
`resolve-pr-comment`, `resolve-schedule`). Each action maps it onto the step `env` as `CENTAUR_ROOT`,
which `cli.ts` reads, exactly as `turn/action.yml` already maps its `config_root` input to
`CENTAUR_CONFIG_ROOT` on every step. An input per action is explicit in the workflow YAML, shows in the
action's documented interface, and avoids hidden job-level state that a later step could override or
that one bot's job could leak into another's. A job-level `env: CENTAUR_ROOT` would save one line per
action but has no advantage the repo's existing composition needs.

A single helper (`resolveRoot` next to `findConfigFile`) validates the value and joins it, so no caller
joins paths by hand.

### Why `root` is a workflow input and not a config key

The config cannot name its own location (it has to be found first), and anything read from the
checkout can be changed by a pull request branch. A workflow input is committed under `.github/` on
the default branch (chat and scheduled workflows run from it, as do `issue_comment` workflows), so it
is as trusted as the action `@main` reference itself.

### Working directory

The agent's working directory stays at the repository root. It needs the whole monorepo for
cross-package changes, git operations, `create-pull-request` and the existing session layout all
assume it, and the turn state and attachments stay in `.centaur-turn/` at the top. Instead, `prepare`
tells the agent where its area is: the prompt gains one line naming `<root>` as the project folder
and, when `<root>/AGENTS.md` or `<root>/CLAUDE.md` exists, an explicit instruction to read it first.
Claude Code loads `CLAUDE.md` upward from the cwd, so a sub-folder file is not loaded eagerly; the live
check in slice 5 shows whether it also loads lazily when the agent reads files in that folder. This
reuses the persona mechanism, which already passes a path.

### Several bots in one repository

Several bots, one per sub-folder, in one repository is a core requirement. Each sub-folder has its own
config with a distinct `bot`, and each bot gets its own workflows:

- **Registration:** `register` runs once per sub-folder (`root`) and binds that folder's bot to the
  same repository, which the registry already permits (the binding is per bot, `bots/<bot>/repo`).
  The register workflow's `paths` filter lists every sub-folder's config.
- **Dispatch filter:** the message is a `repository_dispatch` to the repository with the bot in the
  payload, so every `centaur-message` workflow in the repo triggers on every message. Each per-bot
  job filters with `if: github.event.client_payload.bot == '<bot>'`. The receiver is unchanged. Cost:
  each bot's workflow starts and skips for other bots' messages.
- **Reusable workflow:** a `workflow_call` workflow in the consumer repo holds the shared steps and
  takes `bot` and `root` as inputs; each bot's thin caller workflow supplies the trigger, the `if`
  filter and the two values, so the YAML is not copied per bot.
- **Concurrency:** the group is distinct per bot (it already includes the bot name, and is built from
  the `bot` input in the reusable workflow), so two bots' turns never queue behind or cancel each
  other.

Example for a sub-folder bot, calling the consumer's reusable workflow:

```yaml
# .github/workflows/centaur-garden-message.yml
on:
  repository_dispatch:
    types: [centaur-message]
jobs:
  turn:
    if: github.event.client_payload.bot == 'garden'
    uses: ./.github/workflows/centaur-turn.yml
    with:
      bot: garden
      root: apps/garden
```

```yaml
# .github/workflows/centaur-turn.yml (reusable)
on:
  workflow_call:
    inputs:
      bot: { type: string, required: true }
      root: { type: string, required: true }
concurrency:
  group: centaur-${{ inputs.bot }}-${{ github.event.client_payload.thread }}
jobs:
  turn:
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: <owner>/centaur/.github/actions/setup-runtime@main
      - uses: <owner>/centaur/.github/actions/turn@main
        with:
          root: ${{ inputs.root }}
```

## Security

- `root` comes only from workflow YAML on the default branch, never from the config, the payload or
  the pull request branch. A comment turn already reads the config, persona, instructions and consumer
  skills from the trusted checkout (`config_root`); with `root`, the same files are read from
  `<config_root>/<root>`, so the trust model is unchanged.
- The MCP policy is read from `<root>/.centaur/mcp-policy.cedar` on the default branch through the
  GitHub contents API, as today. The path now includes `root`, which is trusted per the above;
  encode it as a path (not a ref or query fragment) and reject `..`, a leading `/`, backslashes and
  empty segments, the same checks as `repoPath` in `src/config/schema.ts`, in one shared function.
- After joining, resolve symlinks (`realpath`) on a checkout and refuse a `root` that escapes the
  workspace. This matters for the untrusted pull request checkout, where a branch could make
  `<root>` a symlink; the trusted checkout is the one read, but the check is cheap and covers CLI use.
- A sub-folder bot is not confined to its folder. The prompt tells the agent its project folder, and
  that instruction is the only boundary: the workspace is the whole repository, the token is
  repository-wide, and `push.ts` commits whatever changed. Treat a sub-folder bot as having write
  access to the whole repository, as a root bot has. A rejected alternative, path-scoped commits or a
  post-turn check, is not planned.
- Several bots per repo share one set of GitHub variables and secrets; MCP secrets named in one bot's
  config are reachable by another bot's workflow only if that workflow passes them.

## Migration

The default `root: .` leaves every existing consumer unchanged: same files, same defaults, same
workflow YAML. Adopting a sub-folder is a pure addition: move `.centaur/`, `AGENTS.md`-style files and
skills under the folder, add `root: <folder>` to the consumer workflows and the `paths` filter, then
run the register workflow. The config schema needs no change, so the deploy-before-push ordering for
new keys (`AGENTS.md`) does not apply to `root`; the action scripts do change, but consumers run them
at `@main`, and an older runner ignores an unknown input (a warning), so land the scripts first.

## Test plan

- `test/workflows-config-file.test.ts` style: `findConfigFile`/`resolveRoot` with `root` for both
  config forms, both present in one directory (still an error), neither, `..`, absolute path, empty
  segment, symlink escape.
- The one-style rule: a repo with a root-level config and a sub-folder config is rejected with a
  message naming both paths; a repo with only sub-folder configs, or only a root config, passes.
- `prepare` with a temporary repo whose config, prompts, persona, instructions and skills sit in a
  sub-folder: prompt file read, persona path in `claude_args`, instructions override, consumer skills
  installed, project-folder line and AGENTS.md/CLAUDE.md read instruction in the prompt, working
  directory unchanged. Same with `configRoot` set (comment turn).
- Multi-bot: a temporary repo with two sub-folder configs and distinct bots; `prepare` for each reads
  only its own folder's files; `register` for each root binds its bot to the same repository without
  disturbing the other's binding.
- Workflow templates (`docs/workflows.md`): a check that the documented per-bot filter, reusable
  workflow and concurrency group are distinct per bot, if the repo already lints workflow YAML;
  otherwise covered by the live check.
- `mcp-policy-check` requests `…/contents/<root>/.centaur/mcp-policy.cedar` against a fake GitHub
  requester; a root of `.` requests the existing path.
- `centaur config check` from the sub-folder and with a path argument resolves the policy next to the
  config (`configRepoRoot` already does).
- `test/turn-action.test.ts`: the `root` input reaches `prepare`, `plan-pr` and `finish` as
  `CENTAUR_ROOT`.
- A live check on a scratch monorepo with two sub-folder bots: a message to each produces a PR
  touching its sub-folder, the comment turn answers it, the two bots do not run each other's turns
  and their concurrency groups do not collide, and whether a nested `AGENTS.md`/`CLAUDE.md` loads
  lazily in addition to the explicit instruction.

## Slices

1. `resolveRoot`/root-aware `findConfigFile`, the one-style rule check, schema docs for root-relative
   paths, `CENTAUR_ROOT` read in `cli.ts`; tests above for config reading. No consumer-visible change.
2. `prepare`: prompt files, persona, instructions, skills, the project-folder prompt line and the
   AGENTS.md/CLAUDE.md instruction; `finish` and `plan-pr` config reads.
3. MCP policy path with `root`; `register` and `config check`.
4. Action inputs (`register`, `turn`, `resolve-pr-comment`, `resolve-schedule`); multi-bot workflow
   templates in `docs/workflows.md` (per-bot `if` filter, reusable `workflow_call` workflow, distinct
   concurrency groups, one `register` per root and a `paths` filter covering every sub-folder); a guide
   section in `docs/onboarding.md`.
5. Live check on a scratch monorepo with two bots; docs wrap-up in `docs/config.md` (location section).

## Decisions

1. **Working directory: keep the agent's cwd at the repo root, or set it to `<root>`?** Keep it at the
   repo root. Consequence: `CLAUDE.md` and `.claude/` under `<root>` are not loaded natively, so the
   prompt names the project folder and tells the agent to read the nested `AGENTS.md`/`CLAUDE.md`;
   `sessionDirectory`, `push.ts` and `.centaur-turn/` are untouched.
2. **Is one bot per sub-folder in scope?** Yes, several bots, one per sub-folder, in one repo.
   Consequence: it is core design, with the per-bot `client_payload.bot` filter, a reusable
   `workflow_call` workflow, one `register` per root binding each bot to the same repo, and distinct
   concurrency groups, all covered in the test plan and slice 4.
3. **Confine the agent to the sub-folder?** No; a prompt instruction is sufficient. Consequence: no
   path-scoped commits and no post-turn check, and no confinement follow-up slice; the agent keeps
   repository-wide access (see Security).
4. **Input name and scope?** An action input named `root` on each action that needs it, with
   `CENTAUR_ROOT` as the derived internal env var, following how `turn` already maps `config_root` to
   `CENTAUR_CONFIG_ROOT` per step. Consequence: explicit in the YAML, no hidden job-level state.
5. **Nested `AGENTS.md`/`CLAUDE.md`: explicit instruction or live check?** The explicit prompt
   instruction stays, and the slice 5 live check is the way to learn whether lazy loading also works.
   Consequence: behaviour does not depend on lazy loading.
6. **May a root config and sub-folder configs coexist?** No. A directory holding both
   `.centaur/config.yml` and `.centaur.yml` stays an error (`findConfigFile`, unchanged), and a repo
   uses either one root config or sub-folder configs, never a mix. Consequence: multi-bot repos put
   every bot in a sub-folder.

   Note on enforcement: `findConfigFile(root)` sees one directory only, so it enforces the
   same-directory rule but cannot see that a root config coexists with `apps/garden/.centaur.yml`.
   The mix rule needs a repo-wide check at the point the config is found: when `root` is `.`, reject
   if any sub-folder holds a config; when `root` is a sub-folder, reject if the repo top holds one.
   That adds a scan of the workspace (bounded by looking only for the two config paths, skipping
   `node_modules` and `.git`) and is a new function beside `findConfigFile`, run from `register` and
   `prepare`. It is compatible with multi-bot (each bot keeps its own `root`) but not with a repo that
   keeps a root bot and adds a sub-folder bot, which must move the root bot into a folder first. It
   also means `register`'s `paths` filter, which is per `root`, will not catch a stray new config added
   elsewhere; the check runs on the next register or turn.
