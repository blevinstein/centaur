# Agent skills and rules

Design for giving the agent more information about the Centaur harness (how to reply, reactions,
pull requests, MCP approval, the chat tools, the config) through Claude Code **skills** and
**rules**, without putting more text into the prompt. Status: accepted; all nine decisions were
accepted as recommended and the first slice is implemented (see [What shipped](#what-shipped)); the
live check ran on 2026-11-24 and three points remain unverified (see
[Live check results](#live-check-results)). Terms (turn,
poster, `config_root`, `.centaur-trusted`) are defined in [workflows.md](workflows.md) and
[plan.md](plan.md); the trust model for MCP servers this page builds on is in
[mcp-tool-policy.md](proposals/mcp-tool-policy.md).

## Summary of the design

- The harness guidance that is not a parsed output format becomes a **built-in skill set** shipped in
  the Centaur repo (`skills/centaur-*/SKILL.md`), installed by `prepare` into the runner's user
  skills directory (`$HOME/.claude/skills/`), not the workspace. Only each skill's name and
  description are in context until the agent invokes it.
- The existing `instructions/*.md` and the contracts in `prompt.ts` **stay in the prompt**. They are
  small and always needed; moving them would add a tool round trip for no saving.
- Consumers get their own skills and rules only from the **trusted checkout** (the default branch),
  never from a pull request branch, and the action's settings loading is restricted accordingly.
- A single config key, `skills`, switches the built-in set and the consumer set on or off.

## What the code does today

| Fact | Where |
|---|---|
| The turn runs `anthropics/claude-code-action@v1` with the prompt `Read .centaur-turn/prompt.md and follow it.` and `claude_args` from `prepare`; nothing else (no `settings`, `plugins`, `plugin_marketplaces` input) | `.github/actions/turn/action.yml` (Run agent step) |
| `claude_args` is `--model`, `--effort`, `--allowedTools`, `--max-turns`, `--max-budget-usd`, `--json-schema`, `--mcp-config`, `--append-system-prompt-file <persona>`, `--resume`. No `--setting-sources`, `--add-dir`, `--plugin-dir`, `--settings`, `--disallowedTools` | `buildClaudeArgs`, `src/workflows/prepare.ts:517-545` |
| `--allowedTools` is the config's `allowed_tools` plus `Read(./.centaur-turn/**)` and the chat tool wildcard; `Skill` is never added | `prepare.ts:529-536` |
| Harness guidance in the prompt: four files totalling 1,792 bytes (about 450 tokens): `chat.md` 362, `chat_tools.md` 760, `comment.md` 435, `silence.md` 235 | `src/workflows/instructions/*.md`, loaded by `loadInstructions` (`src/workflows/instructions.ts`), overridable by the config's `instructions` |
| Output-format and untrusted-input text is code: `CHAT_CONTRACT`, `COMMENT_CONTRACT`, `NEW_PR_CONTRACT`, `EXISTING_PR_CONTRACT`, `CANDIDATES_NOTE`, `SILENCE_CONTRACT` | `src/workflows/prompt.ts:10-40` |
| Reactions, MCP approval, the config and the pull request flow are **not described to the agent at all** today: the agent only sees the contracts above | `prompt.ts`, `instructions/` |
| The workspace is the consumer checkout. For a comment turn it is the pull request head branch (untrusted); the config, persona and instructions come from `config_root` (`.centaur-trusted`, the default branch) | `centaur-pr-comment.yml:71-79`, AGENTS.md |
| Sessions for `resume` are stored under `$HOME/.claude/projects/<workspace>` | `sessionDirectory`, `prepare.ts:209` |

## Findings from Claude Code and the action

Verified against the raw docs at `code.claude.com/docs/en/*.md` and the action's source
(`base-action/src/parse-sdk-options.ts`, `docs/usage.md` on `main`), fetched with `vet curl`.

1. **The action loads every settings source by default.** It passes `settingSources: ["user",
   "project", "local"]` unless `--setting-sources` is in `claude_args`, and forwards `--add-dir` as
   `additionalDirectories` (`parse-sdk-options.ts`, the `settingSources` and `add-dir` blocks). It
   uses the `claude_code` preset system prompt plus `--append-system-prompt-file`. It sets no
   `--bare`/`--safe-mode`. The `settings` input is JSON only and the action does not inspect
   `.claude/settings.json` (`usage.md`, security notes).
2. **Skills are discovered from the workspace, home and `--add-dir`.** Project skills come from
   `.claude/skills/` in the working directory and parents to the repository root; personal skills
   from `~/.claude/skills/`; a `.claude/skills/` in a `--add-dir` directory also loads, but only
   while the `project` source is enabled (skills.md "Where skills live", "Skills from additional
   directories"; permissions.md "Additional directories grant file access, not configuration").
   `--plugin-dir` loads a plugin for one session (cli-reference).
3. **Precedence: personal beats project.** With the same name in both, `~/.claude/skills` wins
   (skills.md, precedence table). A skill installed in the runner's home therefore cannot be
   shadowed by a same-named skill on a pull request branch. A name collision between an added
   directory and the project falls to the project for commands, and to first-added for two added
   directories.
4. **Progressive loading.** Only a listing of names and descriptions is in context every turn;
   the body enters the conversation when the skill is invoked and stays there. Each entry's
   `description` plus `when_to_use` is capped at 1,536 characters, and the whole listing is
   budgeted at 1% of the context window (skills.md "Skill descriptions are cut short",
   "Skill content lifecycle"). Eight skills with 300-character descriptions cost about 600 tokens
   a turn, which is more than today's 450-token instruction text, so skills pay off only for
   guidance that is long and rarely needed.
5. **Rules.** `.claude/rules/*.md` without `paths:` load at launch like CLAUDE.md; with `paths:` they
   load when a matching file is touched (memory.md "Organize rules with `.claude/rules/`"). A rule
   is not progressive: always-on rules cost their full text each turn, so a rule is just prompt text
   in another place. Project rules are skipped when `project` is excluded from `--setting-sources`.
   Rules and `CLAUDE.md` from `--add-dir` load only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
   (memory.md "Load from additional directories").
6. **`allowed-tools` in skill frontmatter grants tools without a prompt for the invoking turn, even
   in `-p` runs in untrusted folders**, and does not restrict other tools (skills.md "Pre-approve
   tools for a skill"). A project skill can therefore widen the allowlist `allowed_tools` sets.
   `hooks` in skill frontmatter and `.claude/settings*.json` carry the risks already listed in
   [mcp-tool-policy.md](proposals/mcp-tool-policy.md).
7. **Skills are live-reloaded** from `~/.claude/skills`, the project and `--add-dir` directories
   (skills.md "Live change detection"). A turn that writes under `.claude/skills/` could add a
   skill mid-turn.
8. **A pull request branch is already an input to the agent's configuration.** Because the project
   source is on, a comment turn (workspace = PR head) loads that branch's `CLAUDE.md`,
   `.claude/rules`, `.claude/skills` and `.claude/settings.json` today, although the config, persona and
   instructions are read from `.centaur-trusted`. This predates this proposal; skills would widen it
   (`allowed-tools`), so Decision 4 closes it.

Still unverified after the live run (see [Live check results](#live-check-results)):

- Whether `Skill` must appear in `--allowedTools` for the agent to invoke a skill in a `-p` /
  action run. The docs say Claude can invoke any skill by default and that denying `Skill` disables
  all of them; they do not say what a non-interactive run does with an unlisted `Skill` call.
- Whether a skill's body is retained in a `--resume`d session (the docs say it persists in the
  conversation, and `resume` restores the conversation) and whether the listing is rebuilt from the
  current skills directory on resume.
- ~~Whether `--setting-sources user` also drops the project `CLAUDE.md`~~: verified 2026-11-26, the
  trusted `CLAUDE.md` did not reach a comment turn.
- The runner image's Claude Code version, which several skills features depend on (for example the
  version-gated worktree and add-dir behaviors).

## Where the skills live and ship

| Option | Assessment |
|---|---|
| **A. Centaur repo, installed into `$HOME/.claude/skills/` by `prepare`** | Consumer workflows run the actions at `@main`, so `${{ github.action_path }}/../../../skills` exists next to `dist/` (the turn action already runs `dist/workflows/cli.js` from there). Versioned with the harness code, trusted by construction (it is the Centaur checkout, `.centaur-trusted` for comment turns), outranks project skills, no workspace pollution, nothing to commit in the consumer repo. Costs a copy step and a `$HOME` write on the runner. |
| B. Generated by `prepare` into the workspace `.claude/skills/` | Pollutes the working tree the agent commits from (`NEVER_COMMITTED` would need entries), and a PR branch can already contain a same-named skill that wins nothing but muddles. Rejected. |
| C. Plugin via `--plugin-dir <centaur>/plugin` | Clean namespacing, and the action has a `plugins` input, but plugins can carry hooks, MCP servers and agents, which widens the trusted surface. A skills-only user directory is the smaller thing. Revisit if the set grows hooks. |
| D. `--add-dir <centaur>/skills-root` | Loads skills and, with an env var, rules, but requires `project` source, which Decision 4 may restrict, and grants file access to the directory. Rejected for the built-ins. |
| E. Each consumer repo commits its own copy | Drifts from the harness and cannot be fixed centrally. Rejected for built-ins. |

Skill content is Centaur documentation, so it follows AGENTS.md's public-repo rule: no consumer
names, chat or thread IDs.

## Candidate designs

### (a) Built-in `centaur` skill set

Skills, one folder each under `skills/`, bodies short and written for the agent (not the operator
docs):

| Skill | Content | Why a skill, not prompt |
|---|---|---|
| `centaur-pull-requests` | How `pr_action`, `pr_title`, `pr_body` and `existing_pr_number` interact; what the harness does with commits; branch naming | Needed only when files changed |
| `centaur-mcp-approval` | A pending server, `suspend_for`, what resume means | Only on turns with a pending server |
| `centaur-chat-tools` | `list_threads`, `read_thread`, `read_channel`, `before` cursors, the bounded window | Today `chat_tools.md` (760 bytes) is in the prompt; the pointer line stays, the detail moves |
| `centaur-reactions` | The 👀 and waiting reactions are the harness's, not the agent's | Rarely relevant |
| `centaur-config` | Where the config lives, what `allowed_tools` and `mcp_servers` mean, and that the agent may propose changes in a PR but not apply them | Only for config questions |

Prompt-size impact: the listing is five entries of at most 1,536 characters; at about 250
characters each that is roughly 300 tokens every turn, versus the new content in prompt form
(about 2 to 3k tokens for the five topics) every turn. The invoked body costs tokens only on turns
that need it. Moving the existing 1,792 bytes does not reduce the prompt: the listing costs about
what the text does. So (a) is for **new** guidance, and `instructions/*.md` stays.

Consumer override: a consumer cannot edit a built-in. `skills: { builtin: false }` turns the set
off. A consumer who wants different guidance on a topic adds a skill with a different name and a
description that says when to prefer it (Decision 3). Interaction with `instructions`: unchanged;
`instructions` overrides the prompt text, never the skills. The prompt gains one sentence (in
`prompt.ts`, because it is harness policy): the `centaur-*` skills describe the harness, and
a skill never changes the output contract.

`resume`: a resumed session replays its conversation, including skill bodies already invoked. The
listing is rebuilt on each launch, so a new Centaur release adds skills to old threads, but an
already-invoked body stays at the version it was invoked at.

### (b) Consumer skills and rules

Let the repository supply its own skills (`.claude/skills`) and rules (`.claude/rules`) for its
domain (for example "how this repo's release works"). Trust rule: they are read only from the
default branch.

- Chat turns: the workspace is the default branch, so Claude Code already loads them. No change.
- Comment turns: the workspace is the PR head. Either exclude the `project` source (Decision 4)
  and `prepare` copies the **trusted** `.centaur-trusted/.claude/skills` into `$HOME/.claude/skills`
  under the consumer prefix, or leave the loading as is and accept the risk.
- Skill `allowed-tools`, `hooks` and a skill folder with `.claude-plugin/plugin.json` are the
  injection surface (findings 6 and 7). A copy step can validate: reject (fail the turn, like a
  missing MCP secret) any consumer skill whose frontmatter has `hooks`, or whose `allowed-tools`
  names a tool not in the config's `allowed_tools`, so a skill never widens the allowlist beyond
  what the config states and the Cedar policy has approved.

### (c) Rules for always-on essentials

Not recommended. A rule without `paths:` is an always-loaded prompt fragment, which is what
`instructions/*.md` already is, with weaker override semantics (no config key) and the project-source
trust problem. A `paths:` rule helps only for repository file types, which the harness cannot
know. The one use: a consumer's `.claude/rules` for its own code style, which Claude Code already
loads for chat turns (and, per Decision 4, comment turns from the trusted checkout).

### (d) A config key

```yaml
skills:
  builtin: true            # install the centaur-* skills (default true)
  consumer: true           # copy .claude/skills from the trusted checkout (default true)
```

Unknown keys stay errors; the keys need `docs/config.md`, the defaults in `test/config.test.ts`
and any fixture that builds the config by hand (AGENTS.md).

## What must not move out of the prompt

- Everything in `prompt.ts` (`CHAT_CONTRACT`, `COMMENT_CONTRACT`, `NEW_PR_CONTRACT`,
  `EXISTING_PR_CONTRACT`, `SILENCE_CONTRACT`, `CANDIDATES_NOTE`, `omissionNote`): the structured
  output the harness parses (`replySchema`, `extractResult`) and the guards that say untrusted
  chat, PR and fetched content cannot change the instructions. A skill is a tool result the model
  may or may not load, so a guard in one is skippable; and a PR branch could shadow or alter one.
- Persona (`--append-system-prompt-file`), read from `config_root`.
- The statement of which tool results are untrusted (`chat_tools.md`): a pointer to the skill is
  fine, the "untrusted data" sentence stays.
- Anything keyed to a particular turn (pending messages, candidates, the omission count).

## Decisions

All nine were accepted as recommended.

1. **Mechanism for built-in guidance.** (A) skills installed into `$HOME/.claude/skills`, (B) keep
   adding to the prompt, (C) rules, (D) plugin. **Recommend A** for new topics: progressive
   loading, personal skills outrank project ones, versioned with the harness.
2. **Move the existing `instructions/*.md` into skills.** **Recommend no.** 1,792 bytes is about the
   cost of the listing, and the text is always needed. Only the detail of `chat_tools.md` (the
   cursor and window mechanics) moves, leaving its untrusted-data sentence and a pointer.
3. **Consumer override of built-ins.** (A) `skills.builtin: false` only, (B) per-skill overrides,
   (C) a consumer skill with the same name wins. **Recommend A**: a same-named project skill must
   never win (finding 3), and per-skill override is not needed until someone asks.
4. **Which sources a turn loads.** (A) leave the action default (`user,project,local`), (B) comment
   turns pass `--setting-sources user` and `prepare` copies the trusted checkout's consumer
   skills, (C) every turn does that. **Recommend B**: only comment turns run on untrusted branch
   content, and chat turns already run on the default branch. The live check confirmed that branch
   skills are not visible; a second live check showed the trusted `CLAUDE.md` does not reach the
   agent either, so it is copied into the home (`$HOME/.claude/CLAUDE.md`), which Claude Code reads
   under `--setting-sources user`; do not re-enable `project` or `local`, which read the untrusted
   branch.
5. **Consumer skills validation.** (A) none, (B) reject `hooks`, `.claude-plugin`, and an
   `allowed-tools` outside the config's `allowed_tools`, failing the turn with a message that names
   the skill. **Recommend B**, applied to whatever is loaded from the trusted copy; with Decision 4
   B no untrusted skill loads at all.
6. **`Skill` tool permission.** Add `Skill` to the tool list in `buildClaudeArgs`, as `Read(./.centaur-turn/**)`
   is, only when skills are on. **Recommend** adding it; the live check ran with it present and did
   not test whether it is required (an unneeded entry is harmless).
7. **Config key.** `skills.builtin` and `skills.consumer`, both default true. **Recommend yes.**
   Alternative: no key, always on. The key costs a docs and fixtures update and gives an operator an
   off switch while the feature is new.
8. **Rules.** **Recommend no harness-supplied rules** (finding 5): no progressive loading, same trust
   problem. Consumer rules keep working through Claude Code's own loading.
9. **Delivery.** Plain copy of `skills/` into `$HOME/.claude/skills/centaur-*` at the start of
   `prepare`, removing stale `centaur-*` folders first so a renamed skill does not linger on a
   self-hosted runner. **Recommend** over a plugin (Decision 1).

## Implementation map

| Piece | Where |
|---|---|
| Skill sources | new `skills/centaur-*/SKILL.md` (frontmatter `name`, `description` only; no `allowed-tools`, no `hooks`) |
| Copy to the runner | new `src/workflows/skills.ts` (`installSkills(home, sourceDir, consumerDir?)`), called from `prepare` before `claude_args` is built; the source dir from an action env var set to `${{ github.action_path }}/../../../skills` |
| Consumer validation | same module; frontmatter parsed with a YAML library already in the repo for the config (not hand-rolled) |
| Setting sources and `Skill` entry | `buildClaudeArgs` (`prepare.ts:517`) takes `mode` already; add `--setting-sources` for comment turns |
| Config | `src/config/schema.ts` (`skills`), `docs/config.md`, defaults in `test/config.test.ts` |
| Prompt | one sentence in `prompt.ts`; the `chat_tools.md` detail moves to `skills/centaur-chat-tools` |
| Bundle check | skills are not bundled into the Lambda; `yarn bundle:lambda` output is unchanged (confirm with `rg` per AGENTS.md) |
| `npm`/package contents | `skills/` copied beside `dist/` only if the repo is ever published as a package; consumers use the repository checkout, so nothing now |

## What shipped

- `skills/centaur-{reactions,mcp-approval,thread-commands,pull-requests,chat-tools}/SKILL.md`,
  frontmatter `name` and `description` only. `config` and the guidance on the output fields are not
  skills: the fields carry `description` strings in `replySchema` instead.
- `installSkills` (`src/workflows/skills.ts`), called by `prepare` once a turn is not skipped. The
  source folder comes from `CENTAUR_SKILLS_DIR`, set on the turn action's `prepare` step. Consumer
  skills install as `centaur-consumer-<name>`, so the stale-folder cleanup covers them and a
  built-in name can never be taken; their frontmatter name must equal the folder name. Claude Code
  lists them under the folder-prefixed name (see [Live check results](#live-check-results)).
- `buildClaudeArgs` adds `Skill` when any skill was installed and `--setting-sources user` for
  comment turns only (`local` would read the branch's `.claude/settings.local.json`).
- `skills: { builtin, consumer }` in the config schema, `docs/config.md`, the fixtures.
- Prompt: a "Skills" section (only when a built-in skill was installed); the cursor and window
  detail left `chat_tools.md`, which keeps its untrusted-data sentences, the bounded-window caution
  and a pointer; `replySchema` fields have `description`s and the matching contract prose is
  shorter.

### Rollout order

`register` parses the consumer's config in the Lambda, and consumer workflows run these actions at
`@main`. The `skills` key therefore must not reach any consumer's default branch (and is not in this
repository's own config) until the Lambda built from this change is deployed (`yarn deploy-prod`).
Merging the code to `main` is safe without a consumer opting in: the defaults need no key, and
`skills/` ships with the action checkout. Deploy first, then add the key, then check the `register`
run.

## Test plan and live check

Unit tests (Vitest, helpers in `test/helpers`, no per-test functions; implemented in
`test/skills-install.test.ts`, `test/workflow-skills.test.ts`, `test/skills-files.test.ts`,
`test/reply-schema.test.ts`, `test/config.test.ts` and `test/turn-action.test.ts`):

- `installSkills` copies the built-ins, removes stale `centaur-*`, leaves other user skills alone,
  rejects a consumer skill with `hooks`, `.claude-plugin/plugin.json` or an out-of-list
  `allowed-tools`.
- `buildClaudeArgs` includes `Skill` and `--setting-sources` only in the configured cases.
- Config tests for the `skills` key.
- A test that every `skills/*/SKILL.md` has a `description` under the 1,536-character cap and no
  forbidden frontmatter, so a bad skill fails `yarn verify`.

### Live check results

The check ran on 2026-11-24 on an `experiment/*` branch (workflow dispatched with `gh workflow run
<file> --ref <branch>`, AGENTS.md "Workflow experiments"): scheduled prompts, plus one
pull-request comment turn. The sentinels were made-up tokens kept out of the final tree.

Verified:

- A scheduled turn lists the built-in skills (`centaur-chat-tools`, `centaur-mcp-approval`,
  `centaur-pull-requests`, `centaur-reactions`, `centaur-thread-commands`) and a consumer skill
  from the workspace's `.claude/skills` under `centaur-consumer-<folder name>`, the folder-prefixed
  name and not the bare frontmatter name. The agent invoked the consumer skill and answered with a
  token only its body contains, and invoked a built-in skill and answered correctly from it. The
  run had `Skill` in `--allowedTools`.
- Claude Code's own bundled skills also appear in the listing next to Centaur's (a comment turn
  listed several), so a skill listing is not exclusively Centaur's.
- A comment turn ran with `--setting-sources user` (seen in the run's `claude_args`). A skill
  committed to the pull request branch with `allowed-tools: Bash` and a skill already present in
  the branch tree were not available to the agent, which said so and did not use their tokens.
  The consumer-skill source is the trusted default-branch checkout only.
- Operational: `centaur chat tail --text` clips to 120 characters, so a live-check prompt puts its
  answer first, on one line.

Not verified (open):

- [ ] Whether `Skill` must be in `--allowedTools`: not tested without it. The entry is harmless.
- [ ] Whether a skill body is retained across `--resume`: no resume check was run. It needs two
  chat messages in one `resume` thread; the second asks the sentinel again and the execution file
  shows whether the body was retained or re-invoked.
- [x] The trusted `CLAUDE.md` did not reach a comment turn under `--setting-sources user` (2026-11-26);
  `prepare` now copies it into `$HOME/.claude/CLAUDE.md` ([workflows.md](workflows.md#repository-instructions)).
  Verified live (2026-11-26): a comment turn received both guides, so Claude Code reads
  `$HOME/.claude/CLAUDE.md` under `--setting-sources user`. HTML comment labels were stripped, so
  the labels are `# Instructions from <path>` headings; naming both headings is still to recheck.

Method for a repeat: use a scheduled prompt so no chat message is needed; read the reply with
`centaur chat tail <bot>`; read the run's execution file (the `execution_file` output) for a
`Skill` tool call and the skills listing in the init message. Never print tokens, chat IDs or other
people's messages (AGENTS.md); `chat tail` prints none.

## Docs to update

`docs/config.md` (the `skills` key), `docs/workflows.md` (what `prepare` installs, the comment-turn
setting sources), `docs/pr-comments.md` (trusted skills only), `docs/proposals/mcp-tool-policy.md` (skills as
a surface beside `.claude/settings*.json`), `docs/plan.md` if the SSM or payload layout changes
(it does not), AGENTS.md (one bullet: skills come from `skills/` and the trusted checkout, never the
PR branch), and the `docs/onboarding.md` consumer section.

## Open questions

- Does the runner's Claude Code version (pinned by the action) have every skills feature used here?
  The version is not fixed in this repo.
- Do consumers want a per-skill off switch before a second release? Decision 3 defers it.
- Should the scheduled-prompt path (no thread) get the `centaur-chat-tools` skill at all, given it
  has no chat tools? The skill's description could say so, or `prepare` could install per turn kind.
- Self-hosted runners with a persistent `$HOME`: installing into the home leaks between repos that
  share a runner. A per-turn `CLAUDE_CONFIG_DIR` under `$RUNNER_TEMP` would isolate it, but it also
  moves the session store `sessionDirectory` reads; not investigated.
