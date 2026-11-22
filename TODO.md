# TODO

Work in priority order, following the validation plan in [docs/plan.md](docs/plan.md#validation).
Earlier sections retire the most risk; finish them before building on their results. Check items
off as they land, and record findings that change the design back into `docs/`.

Items that need the maintainer are labeled, and agents must not treat them as done or silently skip
them:

- **[HUMAN ACTION]**: only the maintainer can do it (an account, credentials, a phone, a live bot,
  sending a message to the bot). Agents can't take these. When work stalls on one, add it with what
  it unblocks.
- **[HUMAN APPROVAL]**: an agent does the work or proposes the answer, but the maintainer must
  approve it before it lands (a decision, a merge, a change that deploys to CloudFormation). Agents
  prepare it and stop.

Unlabeled items are free for an agent to complete.

A section moves to [TODONE.md](TODONE.md) once every item in it is checked; whole sections only.

## 9. Follow-ups

- [x] Align alias naming: the CLI accepts aliases matching `[a-z0-9][a-z0-9-]*` but the config
      schema's prompt `destination` allows underscores, so such an alias cannot be created with
      `centaur access approve --alias`. Make the CLI and schema use one pattern (allowing `_` in
      the CLI is the smaller change) and update `docs/cli.md` and `docs/config.md`.
- [x] Close the first-registration race on `bots/<bot>/repo` with a conditional `PutParameter`.
- [x] Add a routing test for `src/lambda/handler.ts`.
- [x] Cache SSM reads in the receiver; each accepted message makes 1 to 3 SSM calls.
- [x] CLI: clearer error when piped stdin has too few lines (`Missing value for <name>.`).
- [ ] Decide whether `destination` aliases are checked against SSM at register time.
- [x] Add `centaur config check` command wrapping `parseCentaurConfig`, and document it
- [x] Switch the package manager from npm to yarn or pnpm (pick one; the maintainer's other
      projects use yarn). Replace `package-lock.json` and update everything that calls npm:
      `AGENTS.md`, `scripts/deploy.sh`, `.github/workflows/*.yml` and the setup-runtime composite
      action (`npm ci && npm run build`), `.nvmrc`/Corepack pinning, the docs that say `npm run`,
      and the `bin` and `deploy-prod` scripts. Verify lint, typecheck, tests, the Lambda bundle and
      `actionlint` still pass.
- [x] **[HUMAN APPROVAL]** Roll out `thread_key` in this order, since a workflow that uses it
      against a receiver that doesn't send it yet puts all of a bot's threads in one concurrency
      group and drops pending turns: (1) deploy the receiver (`yarn deploy-prod`), (2) update
      `garden`'s `.github/workflows/centaur-message.yml` to use `thread_key` in its concurrency
      group, (3) merge or close open `centaur/<bot>-<raw thread id>` PRs, and (4) confirm on a real
      run that the raw `thread_id` doesn't show in the Actions UI or logs. The old `garden` branches
      that carried the raw thread ID were deleted (next item).
- [x] **[HUMAN APPROVAL]** Delete the old `garden` branches `centaur/garden-telegram--1003801969329`
      and `centaur/garden-telegram--1003801969329-13`; their names carried the raw thread ID, which
      the `thread_key` rollout otherwise removed. Deleted (tips 2818c5c and 798343b; related merged
      PRs #9 and #8).
- [x] Stop exposing thread IDs (Telegram chat and topic IDs) in the per-thread concurrency group
      name and the `centaur/<bot>-<thread>` PR branch name; use a short hash. Needed before any
      public consumer repo such as `garden`.
- [x] Tag billable resources with `Business=Centaur` through stack-level tags in
      `scripts/deploy.sh` (`BUSINESS_TAG` overrides the value); see
      [docs/deploy.md](docs/deploy.md#cost-allocation-tag).
- [x] Admin claim flow so the owner never looks up their own ID (`centaur admin claim <bot>`; see
      [docs/plan.md](docs/plan.md#access-requests)).
- [x] Rewrite `README.md` for public consumption; it is badly out of date (still says design
      phase). Cover: what centaur is and the architecture in one picture, a short demo of a chat
      exchange and the PR it produces, how a repo adopts it (the three files `.centaur.yml`,
      persona and prompts, the caller workflow, the repo variables and secret), a quick start for
      the maintainer (deploy, bot, admin claim, register), the safety model (admin approval, no
      content in GitHub logs, cost caps), and links into `docs/`.
- [x] Draft a logo: a centaur crossed with a cat (nodding to the GitHub Octocat). Produce a few
      SVG concepts and a README header; the maintainer picks one. Don't reuse GitHub's Octocat
      artwork directly: its usage guidelines restrict modification, so make an original
      centaur-cat hybrid.
- [x] Remove `npmPreapprovedPackages` (`@blevinstein/chat-state-dynamodb`) from `.yarnrc.yml`, no
      earlier than 2026-11-22T06:10Z (24 hours after the 2026-11-21T06:09Z publish of 0.4.0, the
      version `yarn.lock` pins; 0.3.0's gate clears sooner). The age gate
      (`npmMinimalAgeGate`) protects against freshly published malicious versions, and the entry
      exempts every future version of the package. `yarn.lock` pins the resolved version, so the
      exemption is not needed to install it. Afterwards `yarn install --immutable` must still pass.

## 11. MCP support

- [ ] Poster MCP tool for mid-turn questions and progress messages (builds on the MCP server
      config below).
- [x] Design additional MCP servers in the config: [docs/mcp.md](docs/mcp.md), all
      recommendations accepted.
- [x] MCP servers 1: schema and validation (`mcp_servers`, `secretRef`, name refinements and the
      `allowed_tools` cross-checks in `src/config/schema.ts`), with tests and `docs/config.md`.
- [x] MCP servers 2: pure `buildMcpConfig(servers, env)` in `src/workflows/`, with tests.
- [x] MCP servers 3: `prepare` writes `.centaur-turn/mcp.json`, `buildClaudeArgs` adds
      `--mcp-config`, and the turn fails on a missing secret.
- [x] MCP servers 4: caller-workflow docs (`env:` pattern, the `Bash` caveat) in
      `docs/workflows.md` and `docs/onboarding.md`.
- [x] MCP servers 5: verified against the GitHub MCP server (`https://api.githubcopilot.com/mcp/`)
      in this repo: `${VAR}` expansion in `--mcp-config` headers and the `mcp__ghmcp__*` wildcard
      both work. The Actions token has no user identity, so `get_me` is not exposed to it.
- [x] MCP servers 6: Cedar policy at `.centaur/mcp-policy.cedar` in the repo, always read from the
      default branch through the GitHub API and enforced on the runner by `prepare` and `register`
      (fail closed; see [docs/mcp.md](docs/mcp.md#operator-policy)). **[HUMAN APPROVAL]** Merge the
      policy file to the default branch together with, or before, any `mcp_servers` config, and add a
      `CODEOWNERS` entry or ruleset requiring review on it.
- [x] MCP servers 7: global operator policy `infra/mcp-policy.cedar`, zipped into the Lambda by
      `scripts/deploy.sh` and served by the poster's `get-mcp-policy`; merged with the repo policy
      into one Cedar set on the runner (a global `forbid` cannot be lifted). Not verified live.
      **[HUMAN ACTION]** Deploy the stack (`yarn deploy-prod`) so the poster serves `get-mcp-policy`;
      until then every turn and registration with `mcp_servers` fails closed. Then confirm a turn
      with `mcp_servers` still passes and an unpinned local server is denied.
- [ ] Explore **approval-required** MCP servers: a level between deny and allow where the operator
      policy marks a server (or tool) as needing a human decision, and the bot asks in Telegram (with
      emoji reactions or buttons) before the turn uses it. Consider both synchronous (the turn waits)
      and asynchronous (the turn proceeds without it, and a later turn is offered it) variants. It also
      needs a way to express the third outcome in Cedar (for example a separate `RequireApproval`
      action) and a state record for decisions. Keep the harness small: explore first, decide scope
      before building.
      Design and recommendations: [docs/mcp-approval.md](docs/mcp-approval.md); **[HUMAN APPROVAL]**
      accept or amend its Decisions before building.

- [ ] Chat context tools: let the agent read other threads in its chat through a built-in MCP server
      backed by new poster operations. Design and recommendations:
      [docs/chat-context.md](docs/chat-context.md); **[HUMAN APPROVAL]** accept or amend its
      Decisions before building.
- [ ] Chat search: the Chat SDK has no history search, so any search is ours. Proposal (a bounded
      poster-side filter first, no new infrastructure):
      [docs/chat-search.md](docs/chat-search.md); **[HUMAN APPROVAL]** accept or amend its
      Decisions before building.
- [ ] Decide and set the stored-history window (`history.thread` `maxMessages` and `ttlMs`)
      explicitly in `src/lambda/chat.ts`. Telegram keeps only the newest 100 messages per chat and
      per thread (SDK default, 7-day TTL); the poster's `STORED_HISTORY_SCAN_MAX` (2000) is moot
      until this is set. Measure the adapter's cost per append first (it reads the whole list to
      trim). See [docs/chat-search.md](docs/chat-search.md).

## 12. Slack support

- [x] App manifest template with the required scopes and event URL
      ([docs/slack-app-manifest.yml](docs/slack-app-manifest.yml), steps in `docs/onboarding.md`).
- [x] **[HUMAN APPROVAL]** One Slack app per repo.
- [ ] Slack `/new`, `/resume` and `/transcript`. Slack intercepts messages that start with `/`.
      Admin slash handlers (`onSlashCommand` in `src/lambda/admin-handlers.ts`) exist on `main`; the
      incomplete attempt at these three commands is still on the local branch
      `wip/slack-slash-commands`: its handlers dispatch, but a slash command never lands in channel history, so the workflow never sees
      it, and slash commands can't target an existing thread. Options: real slash command for
      `/new` only with the command carried in the dispatch payload, plus a plain-text form
      (`!resume`, `!transcript`) in threads; or text forms only. Deprioritized.
- [ ] **[HUMAN ACTION]** Onboard one personal-project repo on Slack: create the app from the
      manifest once it exists, install it, store its secrets, invite the bot.
- [ ] **[HUMAN ACTION]** Measure the Slack webhook acknowledgement time; Slack expects a 200 within
      about 3 seconds.
- [ ] If the 3-second limit is missed, acknowledge first and finish the reaction and dispatch in
      the background.

## 14. Agent-chosen PR targets

The agent picks which PR its changes land on, in trusted code with fallbacks. Decisions (accepted):
`pr_action: update|new` in comment turns, stacked on the original PR's head when that head is an
ancestor of the working tree, else on the default branch; `existing_pr_number` in chat and
scheduled turns, with candidates from any thread of the same bot (the PR need not be linked to the
current thread); an invalid number falls back to the normal thread PR; defaults `comment_new: true`
and `existing` enabled. Candidates and the final choice are re-derived from GitHub in trusted code
(open, same repo, not a fork, `centaur/<bot>-` branch, authored by the workflow bot, and when a
poster record exists it names the same bot); never from the turn state.

- [x] PR targets 1: config block `pull_requests` (`comment_new`, `existing: off|bot`) in
      `src/config/schema.ts`, `replySchema` parameters (fields appear only when enabled),
      `extractResult`/`resultMessage` fields, contract text, tests, docs. No behavior change yet.
- [x] PR targets 2: `prepare` lists candidate open PRs for the prompt (fenced as data, capped at 10).
- [x] PR targets 3: `plan-pr` validation as a pure function with a fake GitHub client and poster.
- [x] PR targets 4: `push-existing` transplant (patch, worktree, `git apply --3way`, plain push, fall
      back on conflict), tested on real git repos.
- [x] PR targets 5: wire the `turn` action (`plan-pr`, conditional `create-pull-request` and
      `push-existing`), chat note and marked PR comment.
- [x] PR targets 6: comment-mode `pr_action: new` (`pushNewBranch`, `createPullRequest`, double link).
- [x] PR targets 7: docs sweep, including the "dismiss stale approvals" advice.
- [x] PR targets 8: **[HUMAN ACTION]** real runs on `centaur-hello` (`-f prompt_name=pr-smoke`):
      a second run updates an open PR, a merged or closed PR falls back, a comment `pr_action: new`
      opens a stacked PR whose comments resolve to the same thread.
- [ ] Verify the `plan-pr` rejection and `push-existing` conflict fallbacks in a real run. A prompt
      can't make the agent name a PR outside the candidate list (two attempts omitted
      `existing_pr_number`), so this needs a PR that closes or conflicts between candidate listing
      and the push; today only unit tests cover it.
- [x] Match `centaur/<bot>-` branches exactly in `checkCandidate` (a bot named `sprout` also
      matches `sprout-2`'s branches when no poster record exists).
- [ ] Rank PR candidates by update time instead of number if busy repos show stale ones.
- [x] Investigate the intermittent failure in `test/chat-dynamodb-state.test.ts` ("drops the oldest
      queued message beyond maxQueueSize").
- [x] Move the security-relevant parts of the turn state out of the workspace, since the agent can
      edit `.centaur-turn/state.json`. The whole file moved to `$RUNNER_TEMP/centaur-turn/` (every
      field steers a trusted step); a `Bash` tool in `allowed_tools` can still reach it, see
      docs/workflows.md "Turn state".

## 15. Bounded transcript

Design (decided): the earlier transcript fills at most `context.transcript_max_percent` (default
25) of the model's context window, newest first, using polytokenizer; older messages are reached
through the chat context tools. See [docs/plan.md](docs/plan.md#context-management),
[docs/workflows.md](docs/workflows.md#transcript-budget-planned) and
[docs/config.md](docs/config.md#context).

- [ ] Bounded transcript 1: add `polytokenizer` as a dependency (published to npm; 1.0.23 is
      months old, so the age gate does not block it, and `.yarnrc.yml` has no exemption to
      maintain). It pulls in the OpenAI, Google and Anthropic clients, so keep it runner-only: out
      of the Lambda bundle, like `src/config/mcp-policy.ts`. `yarn install --immutable` must pass.
- [ ] Bounded transcript 2: schema keys `context.transcript_max_percent` (integer 1 to 100, default
      25) and `context.window_tokens` (optional positive integer) in `src/config/schema.ts`, with
      `docs/config.md` updated from "planned", the defaults in `test/config.test.ts` and any
      fixture that builds the config by hand.
- [ ] Bounded transcript 3: budget the transcript in `prepare` (window from `window_tokens`, else
      `CONTEXT_LIMITS` for `anthropic/<model>`, else 200,000; newest-first fill; pending messages
      always shown; a single message cut to half the budget with a marker; an omission note in
      `prompt.ts`). Compute pending messages and the marker from the full transcript first. Make
      sure token-count failures never write message text to the job log (polytokenizer's fallback
      logs a text preview). Update the "planned" markers in `docs/` when it lands.
- [ ] Bounded transcript 4: tests with a fake counter in `test/helpers/`: fill order, budget
      boundary, oversized message, omission note with and without the chat tools, window fallback,
      and that pending messages and the marker are unchanged.
- [ ] Bounded transcript 5: depends on the chat context tools item (section 11) for retrieving
      omitted messages; until it ships the omission note says they are unavailable.

## 16. Platforms and destinations

Design (proposal): [docs/platforms-and-destinations.md](docs/platforms-and-destinations.md). Slice
order, files and dependencies are in its implementation plan; Lambda slices accept old and new
input, and runner slices merge only after the Lambda they call is deployed.

- [ ] **[HUMAN APPROVAL]** Accept or amend the Decisions in the design doc before building.
- [ ] Platforms 1: config schema (`platforms` map, legacy normalization, prompt `destination` as a
      name or per-platform map, prompt `platforms`); readers take per-platform settings.
- [ ] Platforms 2: connection model and loader (nested and legacy SSM layouts, connection view).
- [ ] Platforms 3: CLI connections (`bot add` onto an existing bot, `--platform` on `access` and
      `admin claim`, `bot list`, `bot remove --platform`). After 2.
- [ ] Platforms 4: CLI `bot migrate` (`--dry-run`, `--revert`, `--cleanup`) and `bot adopt`. After 3.
- [ ] Platforms 5: per-platform registry entry and `register` over declared platforms. After 1, 2.
- [ ] Platforms 6: receiver builds one `Chat` per connection; per-platform `respond_to`. After 2, 5.
- [ ] Platforms 7: poster derives the connection from the thread ID; `start-thread` takes
      `platform`. After 2 (and 5, same `registry.ts`).
- [ ] Platforms 8: platform-scoped chat aliases and the destination resolution order. After 2, 7.
- [ ] Platforms 9: `thread-meta` record stores a thread's context policy; `start-thread` accepts
      `context`, `read` returns `policy`, ownership reads it. After 7.
- [ ] Platforms 10: runner uses the stored policy and passes the prompt's `context` to
      `start-thread` (fixes thread policy storage for every prompt). After 9 is deployed.
- [ ] Platforms 11: destination records, create on first use, topic recreation,
      `resolve-destination`, IAM for `destinations/*`. After 7, 8, 9.
- [ ] Platforms 12: Slack persistent thread destinations. After 11.
- [ ] Platforms 13: admin-only `/destination <name>` (Telegram) and `!destination <name>` (Slack).
      After 11 and 6.
- [ ] Platforms 14: `centaur destination set|list|remove`. After 11.
- [ ] Platforms 15: multi-target scheduled turns (turn state targets, fan-out in `finish`). After 1,
      7, 10.
- [ ] Platforms 16: persistent-thread scheduled turns (history, marker, session, `resolve` job and
      concurrency template). After 11, 15 and bounded transcript 3 (section 15).
- [ ] Platforms 17: docs sweep (`onboarding.md`, `plan.md`, `config.md`, `cli.md`, `poster.md`,
      README); mark the design doc as built.
- [ ] **[HUMAN APPROVAL]** Deploy the Lambda (`yarn deploy-prod`) after slices 2, 5, 6 and 7 and
      confirm existing bots still answer and post; deploy again after 8, 9 and 11 before the runner
      slices (10, 15, 16) merge to `main`.
- [ ] **[HUMAN ACTION]** Migrate per bot as in the design doc's Migration section: optional
      `centaur bot migrate`, `centaur bot add <bot> --platform slack`, a Slack app event URL change,
      `centaur admin claim <bot> --platform slack`, and a test message on each live bot. If
      `garden-slack` exists, fold it in with `centaur bot adopt` and merge or close its open
      `centaur/garden-slack-*` pull requests first.
- [ ] **[HUMAN APPROVAL]** After a soak, unbind and remove the old Slack-only bot and its config.
- [ ] **[HUMAN ACTION]** Live checks on the test bot: two platforms on one bot, a persistent topic
      and Slack thread, and the error text for a deleted and a closed Telegram topic (confirm the
      recreate and reopen rules).

## Quality Improvements

- [ ] Bots across platforms and topic destinations: one bot with several platform connections, and
      named destinations that point at a topic or thread. Design, alternatives and the Decisions:
      [docs/platforms-and-destinations.md](docs/platforms-and-destinations.md); implementation is
      tracked in section 16.

## Needs triage

Some of these are items that can be implemented in a single task; others require planning and
discussion before implementation. If a task has many subtasks, break it out into its own section
for detailed tracking.

- [ ] Move not-yet-implemented docs into a proposals/ subdir to separate from already-implemented.
- [x] Create a TODONE.md file, and move sections of fully-completed TODO items into TODONE.
- [ ] Setup .centaur config for ~/dev/finance repo - monarch integration, consider using ledger for
      selected transactions (or link to gsheets), weekly transaction review and liquidity check
      (knows which credit card balances are paid from which bank accounts), quarterly investment/
      insurance/plan review
- [ ] Setup .centaur config for ~/dev/resume repo - e.g. exploring new business opportunities,
      responding to recruiter emails, looking for consulting opportunities, etc
- [ ] Centaur-provided prompt instructions explaining harness quirks etc
- [ ] Merge harness instructions with agents.md and situational prompt
- [ ] Add support for skills and rules
- [ ] Consider adding email support, think about SMTP complexity
- [ ] Execution modes (current mode with PR approval, alternative mode with agent pushing directly,
      prompts should explain mode clearly to the agent)
- [ ] Setup .centaur config for ~/dev/turo-accounting repo - try to use playwright to integrate
      with Turo admin portal?
- [ ] Explore a hosted option, BYOKs, using central AWS infra instead of self-hosted, understand
      cost (lambda + dynamo), security model, what would the Function URLs look like. Revisit the
      poster caller check when exploring this: self-hosted accepts that any repo under the owner can
      act as any bot ([docs/poster.md](docs/poster.md#security-model)); a hosted option needs a
      per-repo token and a reserved-concurrency cap on the function.
- [ ] Better guides - basic response-only bot, adding scheduled actions
- [ ] Support for centaur in a sub-folder? What would need to change? Explore and plan

## Backlog

Every item here is **[HUMAN APPROVAL]**: do not start one without the maintainer saying so.

- [ ] The receiver reads every bot, with its token and secrets, once per Lambda container
      (`createReceiver`), so a new bot or a changed token is ignored until the container restarts.
      Reload bots when a request names an unknown bot or a platform call fails with an auth error,
      or cache them with a short TTL like the parameter store wrapper.
- [ ] Per-call MCP policy (proposal): filter MCP tool calls by argument (for example a mutating
      tool only for selected IDs) with a `CallTool` Cedar action, evaluated per call by a Claude
      Code `PreToolUse` hook, failing closed. Design, the catalogue of ways a misconfiguration could
      grant too much, and the hardening steps (schema validation, literal lint, exit-2 hook
      contract, post-run audit, settings isolation, dry-run command):
      [docs/mcp-tool-policy.md](docs/mcp-tool-policy.md). A first cut with tests, not yet hardened,
      is on the branch [`proposal/mcp-tool-policy-first-cut`](https://github.com/blevinstein/centaur/tree/proposal/mcp-tool-policy-first-cut). Needs a live experiment first (**[HUMAN ACTION]** to approve
      the `experiment/*` run).
- [ ] Plan for long-running agent turns (>15 mins) which will hit lambda function runtime limits.
      This may happen if we are using MCP tools etc which take a while to respond.
- [ ] Decision model: a cheap model that decides whether to reply to unaddressed messages in
      `respond_to: all` chats before the main agent runs (see
      https://docs.venice.ai/guides/features/decisions for the pattern). Preferably in the receiver,
      before dispatch, so a skipped message costs no workflow run; it needs a model key in SSM and
      a yes/no call that fits the webhook time budget. Leave it in the backlog; cheap models for
      the main agent are enough for now.
- [ ] Media lifecycle. Attachments from every registered repo's bots land under
      `attachments/<bot>/<thread>/` in the single shared session bucket, expiring on one global
      schedule (`AttachmentExpirationDays`). Decide: per-bot or per-repo retention and size
      quotas; deleting a thread's or bot's media on request or when a bot is unregistered;
      whether the workflow role should be limited to its own bot's prefix (today it can read
      every `attachments/*` object); whether media belongs in its own bucket (separate
      encryption, lifecycle and access); non-image attachments (video, audio, documents); letting
      the agent fetch images beyond the newest 10 that `prepare` loads (`MAX_PROMPT_IMAGES`); and
      what the privacy story is for stored personal photos.
- [ ] Test how a turn behaves when `--max-budget-usd` stops a run before a structured reply.
- [ ] Two bots in one group: with a second bot from BotFather, confirm the ownership rules route
      messages correctly (**[HUMAN ACTION]**: the maintainer creates the second bot in BotFather).
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [x] Contribute the DynamoDB state adapter upstream. Chat SDK declined it and points to community
      packages; Centaur uses the published `@blevinstein/chat-state-dynamodb` instead (see
      `docs/research.md`).
- [x] Bump `@blevinstein/chat-state-dynamodb` to 0.4.0 (adapter rejects calls before `connect()`);
      `connectState` already connects every adapter the Lambda creates.
