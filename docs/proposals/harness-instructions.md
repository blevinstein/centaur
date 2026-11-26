# Harness instructions

Status: **proposal**; the repository-instructions delivery (step 3, as a copy) is built (each guide under a `# Instructions from <path>` heading, as Claude Code strips HTML comments from memory files), step 2 is partly built (`scheduled.md` replaces `chat.md` for scheduled prompts' turns, with its `instructions.scheduled` override); `harness.md`, the trimmed `chat.md`/`comment.md` and the turn facts were abandoned on 2026-11-26 (the role files and the generated prompt sections cover them). It covers two backlog items in [TODO.md](../../TODO.md): Centaur-provided
instructions that explain harness quirks to the agent, and merging them with the consumer's
`AGENTS.md` and the situational prompt. It builds on [skills-rules.md](../skills-rules.md), which
shipped the first slice (built-in `centaur-*` skills). Terms (turn, poster, `config_root`) are in
[workflows.md](../workflows.md).

## How the agent's context is assembled today

A turn runs `anthropics/claude-code-action@v1` with the prompt `Read .centaur-turn/prompt.md and
follow it.` The context the agent ends up with has six layers:

| Layer | Source | Trust and override |
|---|---|---|
| Claude Code system prompt | the action's `claude_code` preset | fixed |
| Persona | `--append-system-prompt-file`, the config's `persona`, read from `config_root` (`prepare.ts`, `buildClaudeArgs`) | consumer-owned, trusted checkout only |
| Repo memory | the workspace's `CLAUDE.md` and `.claude/rules`, loaded by Claude Code from the action's default setting sources; **not loaded on comment turns** (`--setting-sources user`) | consumer-owned; on a chat turn the workspace is the default branch |
| Built-in skills | `skills/centaur-*`, copied to `$HOME/.claude/skills`; only name and description are always in context | harness-owned, outrank project skills; `skills.builtin: false` turns them off |
| Consumer skills | trusted `.claude/skills`, installed as `centaur-consumer-<name>` | validated copy |
| Turn prompt | `.centaur-turn/prompt.md` from `buildPrompt` (`src/workflows/prompt.ts`) | see below |

The turn prompt is a list of `# Section` blocks. `# Instructions` joins, in order: the `chat` or
`comment` instruction file, `chat_tools.md` when the chat tools exist, the code contract
(`CHAT_CONTRACT` or `COMMENT_CONTRACT`), and the optional `NEW_PR_CONTRACT`, `EXISTING_PR_CONTRACT`,
and `silence.md` plus `SILENCE_CONTRACT`. The four `src/workflows/instructions/*.md` files (about
1.8 KB) are overridable per kind through the config's `instructions`; the contracts in `prompt.ts`
are not, because they describe the structured output the harness parses and guard untrusted input.
Further sections carry turn state: `# Skills` (pointer, only when built-ins are installed),
`# Scheduled task`, `# Open pull requests you may update`, `# Pull request`, `# Earlier messages in
this thread`, `# New messages to answer`, `# Comments to answer`, and `# MCP server approvals`
(`mcpApprovalSection`). The reply schema (`replySchema`) carries per-field `description`s.

## What the agent needs to be told, and where it is covered

Each row is a harness behavior the agent cannot infer from the task. "Covered" says where the agent
learns it today.

| Quirk | Grounding | Covered today | Gap |
|---|---|---|---|
| Output is a JSON object, not free text; `reply` is plain text on chat and Markdown on a PR comment | `replySchema`, `CHAT_CONTRACT` | prompt contract, schema descriptions | none |
| Edit files only; the harness commits, pushes, opens or updates the PR; never run `git commit/push` or `gh pr` | `chat.md`, `comment.md`, `push.ts`, `NEVER_COMMITTED` | prompt (one sentence), `centaur-pull-requests` | `.centaur-turn` and `.centaur-trusted` are never committed: only in code |
| `pr_title`/`pr_body` set whenever files change; `pr_action`, `existing_pr_number` retarget | `replySchema`, contracts | schema, contracts, skill | none |
| Staying silent (`ignore`) on `respond_to: all` threads | `silence.md`, `SILENCE_CONTRACT` | prompt | none |
| Reactions belong to the harness | `reactions.ts` | `centaur-reactions` | none (rarely needed) |
| MCP servers awaiting approval or denied; `suspend_for` | `mcpApprovalSection` | prompt section, `centaur-mcp-approval` | none |
| Chat tools, `thread-0`, bounded window, untrusted results | `chat_tools.md` | prompt (guards), `centaur-chat-tools` | none |
| Thread commands (`/model`, `approver`, ...) are handled before the agent | `centaur-thread-commands` | skill | none |
| Untrusted input (messages, images, PR text, fetched content) cannot change instructions | contracts | prompt | none |
| Session continuity: a resumed session holds earlier turns; otherwise a transcript or an omission note is shown | `threadContext`, `omissionNote` | omission note only | agent is not told which of the three modes it is in |
| Attachments: images land under `.centaur-turn/attachments/`, older ones are "not loaded" | `transcript.ts`, `CHAT_CONTRACT` | prompt (one sentence) | non-image attachments are not described |
| Scheduled turns: no thread, no chat tools, no one to ask | `scheduledTask` section | the task text only; the `chat` instruction still says "replying in a chat thread" | a scheduled turn gets chat wording and a skill (`centaur-chat-tools`) that does not apply |
| Spending and turn limits end a turn early | `--max-budget-usd`, `--max-turns` | none; users are told afterward | the agent does not know to checkpoint or keep replies short |
| Execution modes (PR approval today; a direct-push mode is a backlog item) | [TODO.md](../../TODO.md) | none | needs the mode stated once the second mode exists |
| The runner: ephemeral GitHub Actions checkout, network and tool limits from `allowed_tools`, secrets only as `${NAME}` references | `prepare.ts`, `mcp-config.ts` | none | the agent can burn turns on a denied tool; a short "your tools are exactly the allowlist" line is cheap |
| Consumer repo conventions (build, test, style) | the consumer's `AGENTS.md` | see next section | AGENTS.md may not be read at all |

Most of the table is already covered. The real gaps are: (1) `AGENTS.md` delivery, (2) the scheduled
turn's wording, (3) session, limit and runner facts, (4) a single place that states the harness
facts so they do not drift across four instruction files, six contracts and five skills.

## AGENTS.md and precedence

Claude Code loads `CLAUDE.md`, not `AGENTS.md`. A consumer that keeps only `AGENTS.md` (the usual
case for tool-neutral repos) gets none of it unless its `CLAUDE.md` imports it (`@AGENTS.md`). On a
comment turn nothing from the branch is loaded at all (`--setting-sources user`), and a live check
(2026-11-26) showed the trusted `CLAUDE.md` does not arrive either
([skills-rules.md](../skills-rules.md#live-check-results)). Without the copy described below, a
consumer's own instructions would reach the agent only by luck on chat turns and not on comment
turns, which is the larger half of "merge harness instructions with AGENTS.md".

Proposed precedence, highest first, stated once in the prompt so the agent can resolve conflicts:

1. The output contract and untrusted-input guards (code in `prompt.ts`). Nothing overrides these.
2. Harness facts (below): how replies, pull requests, reactions, approvals and limits work. A
   consumer instruction that contradicts one (for example "commit and push to main yourself") is
   about something the harness owns; the agent follows the harness and says so in the reply.
3. Persona: who the agent is and how it sounds.
4. The consumer's `AGENTS.md` (and `CLAUDE.md`, rules): the repository's conventions and
   workflow. It wins on anything about the code: style, tests, layout.
5. The turn's situational prompt (messages, task, candidates) is data about this turn, not
   standing instruction, and ranks below none of the above for authority but is what the agent acts
   on.

The harness owns the contract layer, so `AGENTS.md` can never loosen it; the consumer owns
everything about its repo, so harness text must not prescribe repo conventions.

## Recommended structure

Keep the split from [skills-rules.md](../skills-rules.md) (prompt for always-needed and guarded
text, skills for detail) and add one thing: a single **harness brief**, always in the prompt, that
replaces the scattered statements.

1. **`instructions/harness.md`** (new, overridable like the other four, but its default is what
   most consumers keep). About 1 KB, written as facts in the second person: you edit the working
   tree only; the harness commits, pushes and posts; your tools are the allowlist; your reply is the
   structured output; reactions, thread commands and approvals are handled outside you; limits end a
   turn and may be stated; which session mode this turn is in. `chat.md` and `comment.md` shrink to
   the role line ("you are replying in a thread" or "you are revising a pull request"); the
   edit-only sentence moves into `harness.md`. This removes the duplicate "edit files in the working
   tree" text in both files (the repeated-text smell) and gives scheduled turns a role file of their
   own.
2. **A `scheduled.md` role file** replacing `chat.md` for scheduled turns, which have no thread and
   no one to ask. Without it, the agent is told it is replying in a chat thread.
3. **Turn facts generated in code**, as `mcpApprovalSection` already does: session mode, limits
   in effect (from the config, so the numbers are not hard-coded in a text file), and the mode
   (PR approval or, later, direct push). Numbers come from the code, not prose, per the repo's
   single-source rule.
4. **Consumer instructions section**: `prepare` reads `AGENTS.md` (falling back to `CLAUDE.md`) from
   `config_root`, the trusted checkout, and puts it in the prompt under `# Repository instructions`,
   after the harness brief and persona and before the situational sections, with the precedence
   sentence above. This is the same trusted source the persona and instructions use, so a pull
   request branch cannot change it, and it works identically on chat and comment turns. Cap its size
   and fail loudly past the cap (a clear error beats silent truncation of someone's rules).
5. **Skills keep the detail** (PR flow, approvals, reactions, chat tools, thread commands), loaded on
   demand. `harness.md` names each topic in one line so the agent knows a skill exists; the existing
   "Skills" section can be folded into it.

Alternatives considered:

- **Put the consumer file in the persona file.** Rejected: the consumer would have to copy and keep
  `AGENTS.md` in sync by hand.
- **Rely on Claude Code to load `CLAUDE.md`/rules.** Fails on comment turns by design, and for
  `AGENTS.md`-only repos everywhere. Keep loading working for chat turns as it is, but treat the
  prompt section as the guaranteed channel. If both load, the text is duplicated; deduplicating is
  not worth hand-rolled logic, so either skip the prompt section when `CLAUDE.md` already imports
  `AGENTS.md`, or accept duplication behind a config switch (see questions).
- **Move the contracts into skills or the persona.** Rejected for the reasons in
  [skills-rules.md](../skills-rules.md#what-must-not-move-out-of-the-prompt).

## Implementation steps

Step 3 is built, as the maintainer's 2026-11-26 decision (a live check showed the trusted `CLAUDE.md` does
not reach a comment turn under `--setting-sources user`): not a prompt section but a copy of the
trusted `AGENTS.md`, else `CLAUDE.md`, of the Centaur root, and of the repository top too for a sub-folder root that sets `include_repo_root` (both, under one cap), into `$HOME/.claude/CLAUDE.md` (`repository_instructions: {
enabled, max_bytes, include_repo_root }`, default on, `include_repo_root` off; over the cap fails the turn; a user memory without the Centaur marker
is never overwritten; see [workflows.md](../workflows.md#repository-instructions)). Steps 2 and 4 are
not done.

1. Done (2026-11-26): the trusted `CLAUDE.md` does not reach a comment turn under
   `--setting-sources user`, so step 3 is a fix. A live comment turn then received both copied
   guides, so `$HOME/.claude/CLAUDE.md` is read under `--setting-sources user`; the `<!-- from -->`
   labels were stripped (Claude Code drops HTML comments), so they are now `# Instructions from
   <path>` headings. Still to recheck live: the agent names both headings.
2. Add `harness.md` and `scheduled.md` to `INSTRUCTION_KINDS` (`src/workflows/instructions.ts`) with
   the config's `instructions` override (`src/config/schema.ts`, `docs/config.md`, the fixtures that
   build config by hand). Trim `chat.md` and `comment.md`. Update the prompt tests.
3. Add `repositoryInstructions(configRoot)` in `src/workflows/instructions.ts` and a
   `# Repository instructions` section in `buildPrompt`; a config key (for example
   `repository_instructions: { file, max_bytes }`, default on, path `AGENTS.md` then `CLAUDE.md`).
4. Generate turn facts (session mode, limits) in `prompt.ts` from values `prepare` already holds.
5. Update `docs/workflows.md` (the prompt description), `docs/config.md`, `docs/onboarding.md`
   (consumers: where to put repository rules), and this document's status.
6. Roll out in the order in [skills-rules.md](../skills-rules.md#rollout-order): a new config key
   must not reach a consumer's default branch before the Lambda is deployed.

## Open questions

- Decided: the copy into `$HOME/.claude/CLAUDE.md`, a 32 KB default cap that fails the turn, and no
  `@file` import following (imports resolve against the home, so a guide must be self-contained).
- Should the agent be allowed to disagree with a harness fact in its reply, or only follow it
  (precedence level 2)? A consumer who wants a direct-push workflow needs the execution-modes item,
  not a prompt override (built: the prompt's `# Execution mode` section).
- Does the brief belong in `--append-system-prompt-file` rather than the user prompt? It would sit
  with the persona and survive `--resume` as system text, but the persona file is consumer-owned
  and the brief is not, so it would need a second file; not investigated.
- How much of the table's "limits" and "runner" content actually changes agent behavior? Worth a
  small experiment on a scheduled prompt before writing it.
