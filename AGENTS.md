# AGENTS.md

## Workflow experiments

- GitHub can only dispatch workflows that exist on the default branch. Keep a minimal
  `workflow_dispatch` stub on `main`, develop the real workflow on an `experiment/*` branch, and
  run it with `gh workflow run <file> --ref <branch>`.
- A branch checked out in another worktree can't be checked out here; reuse that worktree or
  remove it first.

## Task lists

- [TODO.md](TODO.md) holds all open work, agent and human. Items needing the maintainer are labeled
  **[HUMAN ACTION]** (only the maintainer can do it: accounts, credentials, messaging the live bot)
  or **[HUMAN APPROVAL]** (an agent prepares it, the maintainer approves before it lands: decisions,
  merges, changes that deploy to CloudFormation). When work stalls on one, add it to `TODO.md` with
  the label and what it unblocks; don't do or skip it silently.
- [DONE.md](DONE.md) holds completed sections: move a section there, whole, once every item in it is
  checked; never move individual items.

## Development

- TypeScript (ESM, Node 24 to match the Lambda runtime; see `.nvmrc`). Run `corepack enable` and
  `yarn install --immutable` once, and again in every fresh worktree before any yarn script
  (`yarn format`, `yarn verify`); Corepack uses the Yarn version pinned in `packageManager` in
  `package.json`.
- Yarn does not auto-install peer dependencies; when a tool fails with `ERR_MODULE_NOT_FOUND` for a
  peer (e.g. `vite` for vitest), add it to devDependencies explicitly. Yarn Berry has no `--silent`
  flag.
- `yarn lint` (Biome check: lint, format, import order; `yarn format` fixes), `yarn typecheck`,
  `yarn test` (Vitest, `test/**/*.test.ts`), `yarn build` (tsc to `dist/`).
- `yarn test` starts `amazon/dynamodb-local` through Docker, or uses `DYNAMODB_ENDPOINT` if set.
- Python tooling is uv-only: run Python tools with `uvx` or `uv run`; never use pyenv, pip, venv or a
  pinned Python version, and never document manual Python setup. `yarn lint:cfn` (cfn-lint on
  `infra/`) needs `uv` (`brew install uv`).
- CLI (`src/cli/`, bin `centaur`): all SSM access goes through the `ParameterStore` interface in
  `src/cli/parameter-store.ts`; tests use `test/helpers/fake-parameter-store.ts`. The SSM parameter
  layout is in `docs/plan.md`. Never accept secrets as flags.
- `yarn bundle:lambda` builds the Lambda to `dist/lambda/index.mjs`; `scripts/deploy.sh`
  (`yarn deploy-prod`) bundles, uploads and deploys the stack (see `docs/deploy.md`). Pushes to
  `main` deploy through `.github/workflows/deploy.yml`; changes to `infra/` that touch `DeployPolicy`
  or `DeployRole` need a manual deploy first. `scripts/setup-cd.sh` does the one-time GitHub setup.
  A template change to any IAM role property (including Description) needs permissions the CD deploy role may lack: check DeployPolicy first or deploy by hand.
- The `approver` words (`request`, `leave`, `list`, `add`, `remove`) are parsed once in `src/lambda/approver-commands.ts` and reached from the Telegram slash handler and the Slack DM word.
- A user ID that becomes part of an SSM path (an approver ID) is validated against the platform's ID alphabet (`isUserId`, `src/lambda/approvers.ts`) first.
- A `DecisionRefused` thrown by an applier (`access-decisions.ts`) becomes a reply to the decider and releases the claim.
- Biome covers code and JSON only; Markdown and YAML are not auto-formatted.
- Chat SDK slash commands (`onSlashCommand`) bypass the message handler and its allowlist, so each
  slash handler authorizes itself and falls back to `processMessage` for anything it doesn't own.
- The Lambda `ParameterStore` (`src/lambda/parameters.ts`) and the CLI one
  (`src/cli/parameter-store.ts`) are separate interfaces; adding a method means updating
  `fakeParameterStore` (`test/helpers/receiver-fixtures.ts`) or `FakeParameterStore`.
- Run `yarn lint:cfn` after IAM or template changes.
- Run `actionlint` on `.github/workflows/*.yml` only; it rejects composite `action.yml` files.
- `cookbookSnippets` (`test/helpers/cookbook-fixtures.ts`) reads every `// cookbook:`-tagged cedar
  block after `## Permit cookbook` in `docs/mcp.md`: put new sections before that heading, or tag
  each block with a tested id.
- `src/lambda/handler.ts` builds the receiver and poster lazily at module scope. Test it with
  `importFreshHandler()` from `test/helpers/handler-fixtures.ts`, which resets modules. Declare the
  `vi.mock` calls for the factory modules in the test file, because `vi.mock` only hoists there.
- The receiver's `ParameterStore` is wrapped by `createCachedParameterStore`
  (`src/lambda/cached-parameters.ts`, 30s). `getByPath` and admin-claim reads are deliberately
  uncached; the poster and register paths use the raw store.
- The dispatch payload carries `thread_key` (`src/thread-key.ts`, the 12-hex hash of bot and thread
  ID), which the concurrency group and the PR branch use instead of raw thread IDs. A new public
  name that would embed a thread ID must use `threadKey`, and a payload change must also update
  `centaur-turn.yml`, the template in `docs/workflows.md`, and `docs/plan.md`.
- The state adapter is the published `@blevinstein/chat-state-dynamodb` package (a fork of the
  community one; see its README). Its `TABLE_DEFINITION` and `TTL_ATTRIBUTE` define the test table,
  and `test/infra.test.ts` checks them against `infra/centaur.yml`.
- Who may decide a request goes through `mayDecide` (`src/lambda/approvers.ts`); a new request kind
  decides its own gate there.
- Poster operations that act for a repository take it from the verified OIDC claim, never the
  payload; their strict schemas reject extra keys. Use `createState("")` for cross-bot records.
- A new field in the agent's structured output goes in three places: `replySchema`
  (`src/workflows/prompt.ts`), `resultMessage` and `extractResult` (`src/workflows/finish.ts`), and
  `docs/workflows.md`. The PR step in `.github/actions/turn/action.yml` reads the `pr-details` outputs.
- Agent prompt guidance lives in `src/workflows/instructions/*.md` (copied to `dist/` by
  `yarn build`) and is overridable via the config's `instructions`. Anything the code parses or
  that guards untrusted input stays in `prompt.ts`, not in those files.
- PR comment turns: `resolve` (`src/workflows/resolve.ts`) gates them and never outputs the raw thread
  ID. `COMMENT_PULL_REQUEST` enables comment-mode `prepare`; `src/workflows/pull-request-comments.ts`
  owns PR reading and comment rendering. Every comment the agent posts to a PR carries
  `REPLY_MARKER`, and `finish` pushes with plain `git`.
- Every git call that runs after the agent with a push token (`push.ts`, `transplant.ts`) goes through
  `gitIn` (`src/workflows/push.ts`), which overrides hooks, fsmonitor, ssh command, credential helper
  and signing on the command line; a new such call uses it, never `exec("git", ...)`. Don't disable
  includes: the checkout stores the credential through one.
- `pull_requests.comment_authors` (default OWNER/MEMBER/COLLABORATOR) gates comment turns twice:
  `resolve` checks the event's `author_association` through the lazy `commentAuthors` dep (config
  read from the default-branch checkout), and `prepare` filters pending comments and inline thread
  context by `PullRequestComment.association`. Unlisted humans are omitted, not fenced; a new
  comment source must set `association`. A new config key also needs `docs/config.md`, the defaults
  in `test/config.test.ts` and any fixture that builds the config by hand.
- Test a thread branch (`centaur/<bot>-<thread key>[-<run id>-<attempt>]`) only with
  `isThreadBranch` (`src/workflows/resolve.ts`), never `startsWith`: a bot name can prefix
  another's (`sprout`, `sprout-2`).
- `mcp_servers` are checked against the Cedar policy `.centaur/mcp-policy.cedar` as it exists on the
  repository's default branch, fetched through the GitHub API (`src/workflows/mcp-policy-check.ts`),
  never the workspace copy, because a turn can run on any branch, merged with the global
  `infra/mcp-policy.cedar` (zipped by `scripts/deploy.sh`, served by the poster's `get-mcp-policy`).
  `prepare` and `registerRepo` run the check before any other poster call and fail closed. Keep `src/config/mcp-policy.ts` (cedar-wasm,
  runner-only) out of the Lambda bundle: do not re-export it from `src/config/index.ts`.
- `CallTool` policies (`checkToolCall`, `src/config/mcp-policy.ts`) run per MCP call in the `tool-gate`
  `PreToolUse` hook (`src/workflows/tool-gate.ts`), installed by `prepare` through `--settings` (with `onFailure: "block"` and `--setting-sources user`) whenever
  `mcp_servers` is non-empty. The hook command is a shell wrapper because Claude Code blocks only on exit
  code 2: every failure and any stdout must become exit 2. `audit-tool-calls` re-checks the execution file
  after the agent. Both layers are validated (errors and warnings fail) in `register` and `prepare`, and
  the repo layer's server and tool literals are linted against `mcp_servers` and `allowed_tools`
  (`src/config/mcp-policy-lint.ts`). A forbid must name its action (`== Action::"UseServer"`).
- The MCP approval key `<name>:<fingerprint>` is derived only by `mcpApprovalKey`
  (`src/config/mcp-fingerprint.ts`); `checkRepositoryMcpPolicy` returns `{ issues, approvals }` (plus the layers and lint warnings) and only
  `issues` fail a turn or registration.
- `PrepareDeps.env` carries the secrets named in `mcp_servers`; `prepare` fails before any poster
  call if one is unset. Tests that need git use `test/helpers/git-fixtures.ts`.
- Comment turns run the actions and read the config (`.centaur.yml` or `.centaur/config.yml`), the persona and the instructions from a
  default-branch checkout (`.centaur-trusted`, via `config_root`); the PR branch is the workspace
  root. Don't use `./.github/actions` in a job that checks out untrusted code.
- The structured-output fields `pr_action` and `existing_pr_number` are gated by the
  `pull_requests` config; `prTargetFlags(config)` in `src/workflows/prepare.ts` feeds both the
  schema and the prompt. `checkCandidate` in `src/workflows/pr-target.ts` is the only place a PR
  target is validated; never trust a PR number from the turn state. The turn state lives outside the workspace
  (`src/workflows/turn-state.ts`, `$RUNNER_TEMP/centaur-turn/`); pass `stateDir`, never a workspace path, to `finish`, `notifyFailure` and `describePullRequest`.
- A value that reaches `finish` through the turn action needs both an env entry in
  `.github/actions/turn/action.yml` and a dep in the `finish` command in `src/workflows/program.ts`.
  `plan-pr` and `finish` get `CENTAUR_CONFIG_ROOT` from `inputs.config_root`
  (`test/turn-action.test.ts`).
- Tests must not synchronize on side-effecting probes such as `acquireLock`; wait on a gate the
  handler opens, and fake `Date` instead of sleeping past a TTL.
- Read the config only through `findConfigFile`/`readConfigText` (`src/workflows/config-file.ts`);
  never hard-code a config path. `.centaur/config.yml` and `.centaur.yml` are both supported.
- State adapters reject calls before `connect()`. `ReceiverDeps` and `PosterDeps` take
  `createState(keyPrefix)`, and the code connects each adapter with `connectState`
  (`src/lambda/state.ts`): the receiver once at startup, the poster through a per-prefix cache of
  connected adapters (a failed connect is dropped so the next request retries). `Chat` calls
  `connect()` on the same instance again, which is a no-op. Tests that need the adapter contract
  (calls reject before `connect()`) use `test/helpers/strict-state.ts`.
- `yarn verify` runs lint, typecheck, build, `bundle:lambda` and test; run it on the rebased tree
  before a merge.
- `register` parses a consumer's config in the Lambda, and consumer workflows run these actions at
  `@main`. A config that uses a new or renamed key must not reach the default branch before the
  Lambda with that schema is deployed: deploy, then push, then check the `register` run.
- To verify a live run, use `centaur chat tail <bot>` (`docs/cli.md`): it reads the state table
  (Telegram has no history API, so only the receiver's stored messages exist) or Slack's
  `conversations.history` through the poster's reader and sender filter, and prints no IDs.
  `--replies` adds Slack thread replies and `--reactions` the reaction names (never the reactors),
  so a thread's answers and an MCP request's approval status are readable. Do not
  scan the table or call Slack by hand. Never print tokens, chat IDs or other people's messages.
- This repo is public: keep consumer repo names, chat and thread IDs and tokens out of docs,
  `TODO.md`, tests, fixtures and commits.
- The Lambda bundle (`dist/lambda/index.mjs`) must not contain the MCP SDK or the chat server
  (`modelcontextprotocol`, `centaur-chat`): after changing imports run `yarn bundle:lambda` and `rg`
  the bundle for those strings.
- A new field in a `list-threads` or `read-channel` result (for example `scanned`) goes in
  `src/lambda/chat-context.ts` (schemas and types, which `PosterClient` in `src/workflows/aws.ts`
  reuses), the `docs/poster.md` table and the `test/workflow-turn.test.ts` mocks.
- The stored-history window comes from the `HistoryMaxMessages` and `HistoryTtlDays` stack
  parameters (`HISTORY_MAX_MESSAGES`, `HISTORY_TTL_DAYS`, read in `src/lambda/history-window.ts`,
  which holds the default and limit constants); `test/infra.test.ts` checks the defaults and limits
  in `infra/centaur.yml` against them.
- A config in test fixtures that declares platforms goes through `yamlOf` or `registerConfigText`
  in `test/helpers/config-fixtures.ts`, not a hand-written YAML string.
- Test the stdio chat server entry through the esbuild-bundled spawn helper
  (`startChatServerProcess` in `test/helpers/chat-server-stdio.ts`), not by importing the entry.
- Poster `read` results are parsed by `readResultSchema` (`src/workflows/aws.ts`); a new field on
  `read` needs it. Use `readThread` for the policy and `readThreadMessages` for messages only.
- Destination values at `chats/<platform>/<name>` are read with `parseDestination` and written with
  `encodeDestination` (`src/lambda/destinations.ts`); the CLI reuses them. Never store or compare a
  raw chat ID there.
- A new `TelegramApi` method also needs adding to `fakeTelegram` in
  `test/helpers/poster-fixtures.ts`.
- Per-platform thread behavior lives in `THREAD_PLATFORMS` (`src/lambda/thread-starter.ts`); a new
  platform adds an entry there instead of branching inline. Build thread IDs with `buildThreadId`
  (`src/config`), never by string.
- The earlier transcript is bounded by `context.transcript_max_chars`
  (`src/workflows/transcript-budget.ts`). A prompt-building path that shows history goes through
  `earlierTranscript` in `prepare.ts` and passes `omitted` to `buildPrompt`.
- A `thread: persistent` prompt's `start` targets carry `thread: persistent` (set in `prepare`) and
  `finish` spreads each target into `start-thread`; a `new` prompt never sends `thread`, so the
  runner stays compatible with an older Lambda.
- `markerThreadId` in the turn state records the thread the history was read from; `finish` writes
  the marker only when the primary thread is that thread.
- A scheduled workflow's concurrency group comes from `resolve-schedule`
  (`src/workflows/schedule-group.ts`). A change to its key must update the template in
  `docs/workflows.md` and `.github/workflows/centaur-hello.yml`.
- A scheduled caller (`centaur-hello.yml`, `centaur-dev-next-task.yml`) has no `notify-timeout` job
  because a scheduled run has no dispatch `client_payload`: a timeout posts no notice, and only the
  in-job `notify-failure` step reports a failure.
- Every poster post path (`post`, `start-thread`, a reused persistent thread) posts through
  `postInThread` (`src/lambda/channel-history.ts`), which also records the sent message in the
  chat-level history list on Telegram; a new post path must use it. A failed record only logs.
- The chat tools read Telegram history through `chat.history.thread.collect(channelId)`;
  `chat.channel(id).messages` never reads the stored list. A change to a history reader needs a test
  on the real `Chat` and DynamoDB state (`realTelegramChat`, `test/helpers/real-chat-fixtures.ts`),
  because the scripted chats in other tests hide this.
- A new access request kind goes through `createRequestRaiser` (`src/lambda/access-requests.ts`) and
  the `appliers` map in `src/lambda/access-decisions.ts`.
- The DM-to-request link is keyed `<channelId>:<messageId>` (`MessageRef`, `access-request-store.ts`); a
  new platform adds nothing but must return both from `AdminChannel.notify`. Recipients of a request
  come only from `recipientsFor` (`src/lambda/approvers.ts`).
- The poster's `mcp-approvals` (`src/lambda/mcp-approvals.ts`) reads decisions only through
  `mcpApprovalParameter`, the store's `isDenied` and `createMcpApprovalRequester`, and an error is
  thrown, never answered as `approved`.
- The CLI has no confirmation prompt: destructive commands (`access revoke`, `bot remove`,
  `mcp revoke`) act immediately and print what they removed. `mcp approve` grants access, so it writes only with `--yes`.
- A new method on the `PosterClient` interface also needs stubs in
  `test/helpers/mcp-policy-fixtures.ts` and `test/helpers/chat-server-fixtures.ts`.
- New poster-only fake behavior (such as `openDM` or `adminPost`) goes in `fakePosterChat`.
- `prepare` asks approval-required MCP servers through `askApprovals` (`src/workflows/mcp-approval.ts`):
  one `mcp-approvals` call per turn, never polled, a failure meaning `pending`. A new turn path that
  builds `mcp.json` or `--allowedTools` must take the servers from `withoutServers`, and a turn
  with a thread sets `approvalThread` so the request can be raised.
- A value `finish` reads from the turn state must be written by `prepare`; `FinishDeps` additions
  stay optional so existing finish tests keep passing.
- MCP approval status is shown as a reaction (`src/lambda/approval-reactions.ts`), one table per platform;
  a new platform adds its three emoji there.
- A dispatch path gets its dispatcher from `createBotChat` (`src/lambda/chat.ts`), which wraps it with `withFailureNotice` so a failed dispatch DMs the admin; never build a `RepositoryDispatcher` elsewhere.
  Its minimum interval is the `DispatchFailureNoticeMinutes` stack parameter
  (`DISPATCH_FAILURE_NOTICE_MINUTES`, read in `src/lambda/dispatch-failure-notice.ts`; `0` turns it off),
  checked in `test/infra.test.ts`.
- A poster operation that has no thread must not resolve a connection (`requireBot` fails for a bot
  on several platforms); it takes the bot name alone, as `openBotState` in `mcp-approvals` does.
- `isPinned(command, args)` (`src/config/mcp-policy.ts`) is the only place the launched package is decided,
  from per-command flag tables (`UVX_FLAGS`, `NPX_FLAGS`) that fail closed; a new launcher or flag goes in
  a table with a test case.
- Agent skills come from `skills/centaur-*` (`CENTAUR_SKILLS_DIR`, set on the turn action's `prepare`
  step) and from the trusted checkout's `.claude/skills`, never the pull request branch; both are
  copied by `installSkills` (`src/workflows/skills.ts`) into `$HOME/.claude/skills`, and consumer
  ones are validated there. Comment turns pass `--setting-sources user` (never `local` or `project`: both read the branch). A statement in a
  `SKILL.md` must describe what the code does; check it against the code (and keep `test/skills-files.test.ts`
  passing: frontmatter is `name` and `description` only). A change to reactions, MCP approval, thread
  commands, pull requests or the chat tools needs the matching skill updated.
- The `skills` config key must not reach a consumer's default branch before the Lambda that knows it
  is deployed (`register` parses the config there).
- claude-code-action strips `ACTIONS_ID_TOKEN_REQUEST_*` from the agent's environment, so the chat server reads them from the credentials file `prepare` writes to the turn state directory (`readOidcCredentials`, `src/workflows/turn-state.ts`).

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
