# Execution modes

Status: **proposal**, not built. It is the plan behind the backlog item in [TODO.md](../../TODO.md):
"Execution modes (current mode with PR approval, alternative mode with agent pushing directly,
prompts should explain mode clearly to the agent)". Terms (turn, poster, `config_root`) are in
[workflows.md](../workflows.md); the pull request flow it changes is in
[workflows.md](../workflows.md#choosing-the-pull-request).

## Problem

Every chat and scheduled turn ends the same way: the agent edits the working tree, and trusted
steps open or update a `centaur/<bot>-<thread>` pull request. A person merges it. That review is
the safety property ([plan.md](../plan.md#security): "Changes only via PR"), and it is right for
code. It is the wrong shape for bots whose output is low-risk and high-frequency: a notes repo, a
journal, a data file a scheduled prompt refreshes. There every change costs a merge click, and
unmerged pull requests pile up.

A second mode lets a bot land its changes on the default branch itself. This document defines it,
where it is authorized, what happens when it fails, and how the agent is told which mode it is in.

## Modes

| | `pull_request` (today, the default) | `direct` (opt-in) |
|---|---|---|
| Where changes land | `centaur/<bot>-<thread>` branch, a pull request opened or updated | the repository's default branch |
| Human gate | merge review | none from Centaur; whatever branch protection enforces |
| Agent's contract | edit files; the harness opens the pull request | edit files; the harness commits and pushes to the default branch |
| Agent-visible output fields | `pr_title`, `pr_body`, `pr_action`, `existing_pr_number` | `pr_title` becomes the commit message (`pr_body` is the commit body); the target fields are absent |
| Fallback | none | a failed push opens the usual pull request |

The agent never runs `git` or `gh` in either mode; `finish`, `push-existing` and
`create-pull-request` stay the only writers. That is what lets the same untrusted-output handling
apply (title and body cleaning, `NEVER_COMMITTED`, the plain non-forced push).

Comment turns are not affected. They already push to the pull request's own branch
([workflows.md](../workflows.md#comment-turns)) and a pull request exists by definition. Mode
applies to chat and scheduled turns only, the same scope as `pull_requests.existing`. `direct` is
allowed on both, and is never on by default (see [Decisions](#decisions)).

### Naming

The turn state already has a `mode` field (`chat`, `comment`, scheduled), and the harness-instructions
proposal reserves "mode" for a turn fact. To avoid three meanings, the config key is `execution`
and the value is called the **execution mode** everywhere, in code and in prose.

## Config shape

A new strict block, bot-wide like `pull_requests`:

```yaml
execution:
  mode: direct            # pull_request (default) | direct
```

- `mode` selects the behavior above. Default `pull_request` keeps every existing config valid, so
  `direct` is opt-in per bot and never on by default.
- The target is always the repository's default branch, resolved from the GitHub API the way
  `mcp-policy-check.ts` already resolves it, never from the agent or the workspace. There is no
  `branch` key and no `on_failure` key: a failed push always falls back to a pull request.

A per-prompt override (`prompts.<name>.execution`) is deferred to slice 5, since it lets a prompt
widen privilege and so deserves its own validation.

`pull_requests.existing` and `comment_new` are ignored in `direct` mode on chat and scheduled
turns, and the schema rejects `existing` set to anything but `off` together with `mode: direct`
(`superRefine`, reported with a dotted path like the other config errors). The fields they add to
the agent's output are already omitted when disabled, so the agent sees one contract per mode.

## Who authorizes direct pushes

A direct-push mode is a privilege escalation: today an agent compromised by prompt injection can at
worst open a pull request a human must merge. In `direct` mode the same compromise writes to the
default branch. The authorization therefore has to be as hard to forge as `.centaur/mcp-policy.cedar`.

1. **Config source.** `execution` is read only from the default branch's config. Chat and scheduled
   turns already run from a default-branch checkout, so `prepare` and `finish` read the workspace
   config; comment turns read `config_root`. A pull request branch that edits `execution.mode` takes
   effect only after a human merges it. Because mode only matters for chat and scheduled turns, the
   comment-turn path needs no extra read, but the trusted push step must still obtain the config from
   `CENTAUR_CONFIG_ROOT` (as `plan-pr` and `finish` do) and not from the agent-writable workspace
   when the two differ.
2. **Re-derive in trusted code.** The push step reads the mode itself; the agent's output carries no
   mode field, and the turn state (which the agent can in principle rewrite under an unrestricted
   `Bash`; see [Turn state](../workflows.md#turn-state)) is not the source of truth. Same rule as
   `plan-pr`: authorization comes from the config and GitHub, never from the agent.
   On chat and scheduled turns the workspace is writable by the agent, so `plan-pr` and `push-direct`
   take the mode from the config as committed at the checkout's HEAD (`git show`), never from the
   workspace file. A missing, ambiguous or invalid committed config means `pull_request`, and
   `push-direct` refuses unless the committed config says `direct` (reason `not_direct`), so the
   protected-path check is not the only defense against an agent editing its own mode.
3. **Registration.** `register` already validates the config on the default branch and binds the bot.
   It should print the execution mode. Authorization comes from the config alone; there is no
   poster-side approval of `direct` in v1.
4. **Branch protection is the real enforcement.** The push uses the workflow's `GITHUB_TOKEN`, so it
   is subject to the branch's protection or rulesets. This is a feature: a repository that requires
   reviews or status checks on `main` rejects the push, `push_rejected` fires, and the fallback opens
   a pull request. Direct mode therefore only does anything unreviewed where the repository has
   deliberately allowed `github-actions[bot]` to push (a ruleset bypass actor, or no protection).
   Docs must say this plainly so nobody assumes direct mode bypasses protection, or that protection
   can be skipped.
5. **Token scopes.** Both modes already need `contents: write` on the job
   ([workflows.md](../workflows.md#agent-turn)), so direct mode adds no scope. Do not add a PAT
   path: the dispatch PAT already has Contents write ([plan.md](../plan.md#security)), and the
   least-privilege point is to keep the push on the short-lived job token that branch protection
   governs. A GitHub App token for the push is the upgrade path if consumers want a distinct bypass
   actor.
6. **No workflow triggers.** Pushes made with `GITHUB_TOKEN` do not trigger workflows. In direct mode
   that means CI does not run on the agent's commit. State it in the docs and in the agent's mode
   text ("your change is not tested by CI before landing"). Consumers needing CI must run it in the
   turn (an allowed test command) or accept the gap.
7. **Prompt injection.** In `direct` mode on a chat turn, anyone approved in the thread, or a pasted
   web page the agent reads, can steer a commit to the default branch with no human review from
   Centaur. This is the cost of opting in. The mitigations are branch protection (point 4) and the
   protected-paths fallback below; an operator who cannot accept the risk keeps `pull_request`.
8. **Always-on guards stay.** `NEVER_COMMITTED` paths are never staged. A patch touching a protected
   path is refused outright in `direct` mode and falls back to a pull request, so the agent can never
   edit its own authorization or what runs or who reviews, even where branch protection is absent.
   The protected paths are anything under `.github/` (workflows, composite actions, CODEOWNERS,
   dependabot), any path with a segment starting with `.centaur` at any depth (so a sub-folder
   bot's `<root>/.centaur/` and `<root>/.centaur.yml` count), `CODEOWNERS` at the repo root or
   under `docs/`, and, at any depth, the agent's own configuration and guides that steer later turns
   (`.claude*`, `.codex`, `.gemini`, `.cursor`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`) and
   `.gitmodules`. Matching ignores case.

Net effect: the three layers are the config (default branch only), the trusted push step (never agent
output), and branch protection (the repository owner's decision). An operator who wants safety keeps
the default; an operator who wants speed opts in per bot and still has the ruleset as a
backstop.

## Implementation: how the push works

Reuse `push-existing`, which already does the hard part: stage everything except the never-committed
paths, write a binary patch, fetch the target ref, apply with `git apply --3way` in a detached
worktree at its tip, commit as `github-actions[bot]`, plain `git push`. The two differences are the
target (the default branch, not a `centaur/` branch) and the validity check (`isValidHeadRef` requires
the `centaur/` prefix, which must not be relaxed for the existing path).

To avoid duplicating `pushExisting`, factor its transplant into a function taking an already
validated ref (`transplantAndPush`), with `pushExisting` and the new `pushDirect` as two thin callers
that differ only in how the ref is validated. The new `pushDirect` validates that the ref equals the
default branch name resolved from the API.

A new CLI command `push-direct` (like `plan-pr`) runs in the `turn` action when the trusted config
says `direct` and `inputs.comment == ''`. It writes `fallback`, `reason`, `pull-request-url`
(absent: no pull request) and `commit-sha` outputs. The existing step conditions become: `plan-pr`
runs only in `pull_request` mode; `push-direct` runs only in `direct` mode; `create-pull-request`
runs when the plan is `thread`, `push-existing` fell back, or `push-direct` fell back. The mode is decided by one step (`plan-pr` generalized to an
execution plan with `target: existing | thread | direct`), so the action's `if:` conditions keep
reading one output rather than a second config query. That also keeps a single place that reads the
trusted config for the whole step graph.

## Failures and conflicts

| Case | Behavior |
|---|---|
| Nothing changed | success, nothing pushed, like `push-existing` |
| Patch does not apply cleanly to the tip (`conflict`) | fall back to a pull request; the 3-way merge already tolerates unrelated concurrent commits, so this is a real overlap |
| The default branch moved between fetch and push (`push_rejected`, non-fast-forward) | retry once from a fresh fetch; a second rejection always falls back to a pull request. Never force-push. The retry is safe because the patch is re-applied, not the old commit re-pushed |
| Branch protection or a ruleset rejects the push | `push_rejected`: fall back to a pull request. This is the expected result in a protected repository, so it is a `::notice::`, not a warning, and the reply says the change went through review |
| A protected path (`.github/`, `.centaur*` and agent config or guides at any depth, `CODEOWNERS`) in the patch | fall back (see above) |
| Fallback pull request also fails | existing behavior: `finish` appends "I couldn't open the pull request, so the changes were not saved" |

Reporting: the chat reply gets `Pushed to <branch>: <commit url>` in place of `Pull request: <url>`;
a fallback uses the existing "opened the usual pull request instead" sentence with the reason code.
Reason codes stay content-free (`conflict`, `push_rejected`, `invalid_ref`, `fetch_failed`,
`patch_failed`), reusing `PushExistingFailure`; one new code, `protected_path`, covers the refused
paths. A direct push does not link a pull request to the thread, since none exists; the thread record
stores nothing. Follow-up chat messages simply continue from the new default branch state, which
removes the "stale pull request" problem of the other mode.

The commit message ends with a run-URL footer, like the pull request body's, so the audit context a
pull request would hold is on the commit. Commits are not signed. The push is tried and, if the
repository rejects it, falls back; branch protection is not detected up front.

Concurrency: chat turns of different threads can race on the default branch. The retry-once covers
the narrow window; the bot's concurrency group serializes turns across threads, so the race remains only between
bots; a group spanning bots would stall unrelated bots, so it is not proposed.

## Explaining the mode to the agent

The reply schema, the instruction files and the contracts must match the mode, or the agent will ask
for a pull request in a world with none (or promise "I pushed to main" in a world with review).

Following [harness-instructions.md](harness-instructions.md), which plans a harness brief plus
**turn facts generated in code** (as `mcpApprovalSection` already does), the mode is one of those
facts; this proposal does not restate that design. Concretely:

- `buildPrompt` gains an `executionMode` input (from the trusted config, like `allowExisting`) and
  emits a short generated `# Execution mode` section instead of the current "a pull request is
  opened for you afterwards" sentence in `chat.md`. Until the harness brief exists, that sentence
  moves into the section, so the text is stated once per mode and not duplicated across `chat.md`,
  `NEW_PR_CONTRACT` and `EXISTING_PR_CONTRACT`.
- `pull_request` text: you edit files; the harness opens a pull request that a person reviews and
  merges; nothing you do changes the default branch; write `pr_title` and `pr_body` for that reviewer.
- `direct` text: you edit files; the harness commits them to the default branch and pushes, with no review
  and no CI run; write `pr_title` as the commit message and `pr_body` as its body; the change is
  durable and visible to everyone immediately, so only change what the request asks for, and do not
  guess. If the push is rejected the harness opens a pull request instead; you need not handle it.
- The `replySchema` descriptions for `pr_title` and `pr_body` use the mode's wording; the
  `pr_action` and `existing_pr_number` fields are absent in `direct` mode (consistent with how a
  disabled switch already removes its field and passage).
- The `centaur-pull-requests` built-in skill gets a "which mode am I in" paragraph that defers to
  the prompt section, so the two cannot disagree: the prompt is authoritative.
- Precedence: harness facts outrank repository instructions
  ([harness-instructions.md](harness-instructions.md#agentsmd-and-precedence)). A consumer
  `AGENTS.md` that says "commit and push to main" in a `pull_request` bot is overruled by the
  section, which is the intended resolution, and the open question in that document ("a consumer who
  wants a direct-push workflow needs the execution-modes item, not a prompt override") is answered
  by this proposal.

## Docs to update when built

[workflows.md](../workflows.md) (agent turn steps 3 and 4, a new "Execution modes" subsection next
to "Choosing the pull request"), [config.md](../config.md) (the `execution` block and its table),
[plan.md](../plan.md#security) (qualify "Changes only via PR": it holds for the default mode),
[onboarding.md](../onboarding.md) (how to choose, and the branch protection checklist), and AGENTS.md
(the config and trusted-source conventions). Turn the "Reviewing agent updates" paragraph into a
per-mode note.

## Test plan

Unit tests with the fake `Exec` and fake GitHub client already used by `push-existing.test.ts` and
`plan-pr`:

- Config: `execution` defaults, rejects unknown keys (including `branch` and `on_failure`) and
  unknown modes, rejects `existing` other than `off` with `direct`.
- `pushDirect` (through the shared transplant): applies onto the tip, commits as the bot, pushes the
  default branch, never forces; `conflict`, `fetch_failed`, `push_rejected` map to the codes; the
  retry happens once on a non-fast-forward and re-applies the patch; a second rejection falls back;
  a patch touching `.centaur.yml`, `apps/x/.centaur/`, `.github/actions/` or `CODEOWNERS` yields `protected_path`; an
  empty patch pushes nothing; the ref used equals the API's default branch, never agent text.
- Plan: `direct` bypasses candidate lookup, `pull_request` behaves exactly as today (the existing
  `plan-pr` tests stay unchanged and pass), and the mode is read from `CENTAUR_CONFIG_ROOT`, not the
  workspace, when both exist and differ.
- Prompt and schema: golden tests per mode for the `# Execution mode` section and the field set;
  `direct` has no `pr_action` or `existing_pr_number`; `pull_request` output is byte-identical to
  today's apart from the relocated sentence.
- `finish`: the `Pushed to <branch>` line, the fallback sentence, and no `link-pull-request` call in
  direct mode.

Not unit-testable, so verified once in a real run on a scratch repository before rollout: a protected
branch rejecting `GITHUB_TOKEN` (the central fallback assumption, and the "no workflow triggered"
claim), an unprotected branch accepting it, and a ruleset with `github-actions` as a bypass actor.
The workflow YAML conditions are declarative, so they get no mirror test; the plan step's single
output is what the tests above cover.

## Implementation slices

1. **Config and docs skeleton (built).** `execution` block in `src/config/schema.ts` with its refinements,
   `docs/config.md`, no behavior change (default is today's mode).
2. **Refactor (built).** The transplant is `transplantAndPush` in `src/workflows/transplant.ts`;
   `pushDirect` is in `src/workflows/push-direct.ts`, with unit tests. Its success result carries
   the commit `sha`. No action wiring.
3. **Wire the turn action (built).** Generalize `plan-pr` to the execution plan, add `push-direct`, update
   the `if:` conditions in `.github/actions/turn/action.yml`, `finish` reporting. The real run on a
   scratch repository remains a human action.
4. **Prompt and schema (built).** The generated `# Execution mode` section (`executionMode` input of
   `buildPrompt`, read by `prepare` from `committedExecutionMode`; comment turns get no section),
   the mode's `pr_title` and `pr_body` descriptions in `replySchema`, no `pr_action` or
   `existing_pr_number` in `direct`, and the skill paragraph. The sentence from `chat.md` moved into
   the section; `NEW_PR_CONTRACT` and `EXISTING_PR_CONTRACT` describe fields only, so they stay. A
   bot persona's stopgap paragraph about direct mode can now be dropped. The section folds into the
   harness brief when that exists.
5. **Optional.** Per-prompt override. Poster-side approval of direct mode per bot is not planned.

Rollout follows [skills-rules.md](../skills-rules.md#rollout-order): the config key must not reach a
consumer's default branch before the action that understands it, or `register` fails the parse
(strict block).

## Decisions

- **Direct on chat turns, or only scheduled prompts?** Allowed on both chat and scheduled turns,
  opt-in per bot in config, never on by default. Consequence: a chat participant (or a pasted web
  page) can steer a commit to the default branch, so branch protection and the protected-paths
  fallback (`.github/`, `.centaur*`, `CODEOWNERS`) are the mitigations, and the docs say so plainly.
- **`execution.branch`?** Not in v1. Consequence: the target is always the default branch resolved
  from the API, with no extra ref validation. A non-default target is a possible later variant.
- **Poster-side approval of `direct`?** No; authorization comes from the config only in v1.
  Consequence: no new request kind or storage; the default-branch config is the single control.
  Not planned, even as slice 5.
- **Retry count and `on_failure: fail`?** One retry on a moved branch, then always fall back to a
  pull request. `on_failure` is dropped from the config. Consequence: work is never lost on a failed
  push.
- **Signing or audit trailer?** No signing; the commit message carries a run-URL footer.
  Consequence: the audit context a pull request would hold is on the commit.
- **Detect branch protection up front?** No; try the push and fall back on rejection. Consequence:
  one doomed push attempt in a protected repository, in exchange for logic that is always correct.
