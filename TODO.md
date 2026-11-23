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

A section moves to [DONE.md](DONE.md) once every item in it is checked; whole sections only.

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
  - [x] Config key, poster operations, platform support and the MCP server (steps 1 to 4).
  - [x] Poster-backed client, stdio entry (`dist/mcp/chat-server-main.js`), `prepare` wiring and
        prompt block (step 5); `scope: thread` is unchanged.
  - [ ] Tool gate (step 6): the per-call `CallTool` gate is not on `main`, so only the allowlist
        bounds the server today. Once the Per-call MCP policy item below lands, add a test that a
        `forbid` on `centaur-chat` is honored.
  - [ ] **[HUMAN ACTION]** Chat context 7: real run on `centaur-hello` (or `centaur-test`) in each
        platform with `chat_tools: { scope: chat }` on the default branch (set in `.centaur/config.yml`). Telegram forum group,
        then Slack channel; in each:
        1. In thread A say: "We decided the garden party is Saturday at 6pm and we need tomatoes
           and basil."
        2. In thread B (a new topic or a reply to a different top-level message) say: "Summarize
           what was decided about the garden party in the other thread."
        3. Expect the reply to give Saturday, 6pm, tomatoes and basil. The run's execution log
           should show `list_threads` and `read_thread` on `mcp__centaur-chat__*` and the
           `centaur-chat` server connected; the job log, step outputs and PR text must show no
           message text, thread ID or chat ID.
        4. Ask in thread B: "Put that summary in a pull request description." Expect the agent to
           decline or leave the cross-thread content out.
        5. Set `scope: thread` again and repeat step 2: no `centaur-chat` server or tool calls.
        Also confirm the Slack `conversations.history` and `conversations.replies` rate limits
        hold on this install (see Chat search 6).
- [x] Chat search: the Chat SDK has no history search, so any search is ours. Decisions accepted
      2026-11-22 ([docs/chat-search.md](docs/chat-search.md)): no poster-side filter (the poster
      scans the whole window and the Telegram window fits in one call), report the scanned range,
      and add opt-in Slack-native search; no secondary index (SQLite FTS, OpenSearch, embeddings)
      because of the infrastructure cost. Slices, in order:
  - [x] Chat search 1: `scanned: { oldest, exhausted }` range in `read-channel` and
        `list-threads` results.
  - [ ] Chat search 2: `chat_tools` config key for the Slack search opt-in.
  - [x] Chat search 3: MCP server renders the scanned range and the bounded-window note.
  - [ ] Chat search 4: Slack-native search (receiver captures the `action_token` into the state
        table with a TTL, poster `search-chat`, MCP `search_chat`, manifest scopes). Settle the
        design questions in the doc first.
  - [x] Chat search 5: the stored-history window, tracked in the next item.
  - [ ] **[HUMAN ACTION]** Chat search 4a: when slice 4 is about to be built (not before; least
        privilege), add `search:read.public` to the installed Slack app and reinstall it, as in
        `docs/slack-app-manifest.yml` and [onboarding](docs/onboarding.md#slack-personal-projects).
  - [ ] **[HUMAN ACTION]** Chat search 6: verify on a real install (Slack rate limits,
        `action_token` lifetime and presence in events, AI features in the workspace, Telegram
        window cost).
- [x] Decide and set the stored-history window (`history.thread` `maxMessages` and `ttlMs`)
      explicitly in `src/lambda/chat.ts`. The window is the `HistoryMaxMessages` (default 100,
      max 5000) and `HistoryTtlDays` (default 7, max 365) stack parameters, read by
      `src/lambda/history-window.ts`; the dead `STORED_HISTORY_SCAN_MAX` is gone. Measured on
      DynamoDB Local (which reports no capacity), the adapter's trim reads the whole list on every
      append: 20 / 25 / 31 / 49 / 109 ms p50 per append at 100 / 500 / 1000 / 2000 / 5000
      messages (N+1 items read; two queries at 5000). At 1 KB per message and two lists per
      message that is about N/2 read units, roughly $0.000006 / $0.00003 / $0.0003 per message at
      100 / 500 / 5000 on-demand (estimate). Recommended: 500 messages, 7 days.
- [x] **[HUMAN APPROVAL]** Raise the deployed stored-history window to the recommended 500
      messages (`HistoryMaxMessages=500`, `HistoryTtlDays` stays 7): a CloudFormation parameter
      change. Approved and deployed 2026-11-22; `HistoryMaxMessages` is set in the private
      `parameters-prod.json`, so later deploys keep it. Unblocks chat search and `list-threads`
      seeing more than the newest 100 messages of a Telegram chat.

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

Design (decided 2026-11-24): the earlier transcript fills at most `context.transcript_max_chars`
characters (default 100,000), newest first, with no tokenizer dependency and nothing sent to a
vendor; older messages are reached through the chat context tools. See
[docs/plan.md](docs/plan.md#context-management),
[docs/workflows.md](docs/workflows.md#transcript-budget) and
[docs/config.md](docs/config.md#context).

- [x] Bounded transcript 1: no tokenizer dependency; dropped in favor of a character limit.
- [x] Bounded transcript 2: schema key `context.transcript_max_chars` (positive integer, default
      100,000) in `src/config/schema.ts`, with `docs/config.md` and the defaults in
      `test/config.test.ts`. Done.
- [x] Bounded transcript 3: `prepare` bounds the earlier transcript of chat and pull request
      comment turns (`src/workflows/transcript-budget.ts`, `splitTextMaxChars` in
      `src/workflows/split-text.ts`): newest-first fill, pending messages always shown in full,
      an earlier message over half the budget cut with a marker, and an omission note in
      `prompt.ts`. Pending messages and the marker come from the full transcript; no message text
      is logged. Done.
- [x] Bounded transcript 4: tests with helpers in `test/helpers/turn-fixtures.ts`: the splitter,
      fill order, budget boundary, oversized message, pending messages and the marker, omission
      note with and without the chat tools, pull request comment turn, and the config key. Done.
- [x] Bounded transcript 5: the omission note names `read_thread` on `thread-0` with a `before`
      cursor when `chat_tools.scope` is `chat`, and says the messages are unavailable otherwise.
      Done.

## 16. Platforms and destinations

Design (Decisions accepted 2026-11-22, nothing built):
[docs/platforms-and-destinations.md](docs/platforms-and-destinations.md). There is no backwards
compatibility: slices 1 to 8 are stacked into the branch `platforms/cutover` and go live together in
the one-shot cutover (slice 18, runbook in the design doc's Migration section). Slices 9 to 17
branch from `main` after it; a runner slice merges only after the Lambda it calls is deployed.

- [x] Accept the Decisions in the design doc (2026-11-22): nested SSM layout approved, existing data
      and consumer configs migrated once instead of kept compatible, everything else as recommended.
- [x] **[HUMAN APPROVAL]** Approve the three recommendations under "Open after amendment" in the
      design doc: `register` rewrites the registry entry (so every bot is silent from the Lambda
      deploy until re-registered), `--alias-platform` for chat aliases whose platform cannot be
      inferred, and consumers enumerated from `bots/*/repo`. Taken as approved when the maintainer
      approved the cutover on 2026-11-23; the dry run needed no `--alias-platform`.
- [x] Platforms 1: config schema (`platforms` map only, legacy top-level keys rejected with a pointer
      to `config migrate`, prompt `destination` as a name or per-platform map; its prompt `platforms`
      selector is removed by slice 21); readers take per-platform settings.
- [x] Platforms 2: connection model and loader (nested SSM layout only, connection view).
- [x] Platforms 3: CLI connections (`bot add` onto an existing bot, `--platform` on `access` and
      `admin claim`, `bot list`, `bot remove --platform`). After 2.
- [x] Platforms 4: CLI migration tools: `bot export` and `bot restore`, `bot migrate` (`--dry-run`,
      `--prune`, `--alias-platform`), `config migrate`, and `bot adopt`. After 3 (and 1).
- [x] Platforms 5: per-platform registry entry and `register` over declared platforms; an old-shape
      entry serves nothing. After 1, 2.
- [x] Platforms 6: receiver builds one `Chat` per connection; per-platform `respond_to`. After 2, 5.
- [x] Platforms 7: poster derives the connection from the thread ID; `start-thread` takes
      `platform` (optional on a single-connection bot). After 2 (and 5, same `registry.ts`).
- [x] Platforms 8: platform-scoped chat aliases (flat form not read) and the destination resolution
      order; slice 11 folds aliases into destinations. After 2, 7.
- [x] **[HUMAN APPROVAL]** Cutover go decision: after a passed rehearsal (`bot export` and
      `bot migrate --dry-run` on production; the full sequence on a test bot) and slices 1 to 8
      done, approve the window (about 5 to 10 minutes of unanswered messages), then the
      `yarn deploy-prod` of the Lambda from `platforms/cutover`. Approved 2026-11-23 after the
      production dry run; the test-bot rehearsal was skipped.
- [x] **[HUMAN ACTION]** Platforms 18, the cutover, in the design doc's order: `bot export`,
      `bot migrate`, deploy, `bot migrate` again, merge `platforms/cutover` and each consumer's
      `config migrate` pull request (each merge runs `register`), smoke-test every bot and one
      scheduled prompt per consumer. Rollback: redeploy the previous Lambda, revert the merges and
      re-register. Done 2026-11-23: the window ran about 90 seconds (Lambda deployed 01:59:59 UTC,
      the last `register` finished 02:01:29). All three `register` runs succeeded, the Telegram
      webhooks are set, and the self-consumer `hello` prompt ran. Still to do: a message to each live
      bot, and a scheduled prompt per consumer (not dispatched, since they post to real chats).
- [ ] **[HUMAN APPROVAL]** After a week's soak, `centaur bot migrate --prune` (deletes the flat
      parameters and aliases) and delete the export file.
- [x] Platforms 9: `thread-meta` record stores a thread's context policy; `start-thread` accepts
      `context`, `read` returns `policy`, ownership reads it. After 18.
- [x] Platforms 10: runner uses the stored policy and passes the prompt's `context` to
      `start-thread` (fixes thread policy storage for every prompt). After 9 is deployed.
      Done.
- [x] Platforms 11: replace aliases with destinations (design Decision 18, maintainer ruling
      2026-11-23): widen the `chats/<platform>/<name>` value to a record (chat, optional topic,
      stored policy), rename `chat-aliases.ts`, `resolveChatAlias`, `proposeChatAlias`,
      `recordChatAlias` and `slugAlias` to destination names, one-lookup resolution, create on first
      use, topic recreation, `resolve-destination`; `start-thread` and `resolve-destination` take
      `thread` (Decision 19); the schema parses `thread: new | persistent` (default `new`) and
      rejects `persistent` with a clear error until slice 16 lands; no new IAM statement. Deploy
      gates unchanged. Details approved 2026-11-23. After 8, 9, 18 (and 21, same schema file).
      Done.
- [x] Platforms 12: Slack persistent thread destinations (`thread: persistent` on Slack). After 11.
      Done.
- [x] Platforms 13: dropped (design Decision 20, maintainer ruling 2026-11-24): `centaur
      destination set` binds an existing topic, so the in-chat handlers would add admin-auth
      receiver code for a rare need.
- [x] Platforms 14: `centaur destination set|list|remove`; removes `centaur chat list` (breaking).
      After 11. Done. `chat list` and `access approve --alias` are removed.
- [x] Platforms 15: multi-target scheduled turns (turn state targets, fan-out in `finish`). After 10.
- [x] Platforms 16: `thread: persistent` scheduled turns (the runner passes the prompt's `thread`;
      history, marker, session, `resolve` job and concurrency template); the schema stops rejecting
      `persistent`. After 11, 15 and bounded transcript 3 (section 15). Done.
- [x] Platforms 17: docs sweep (`onboarding.md`, `plan.md`, `config.md`, `cli.md`, `poster.md`,
      README); remove the word "alias" everywhere; mark the design doc as built. Done.
- [ ] **[HUMAN APPROVAL]** Deploy the Lambda (`yarn deploy-prod`) after each of slices 9, 11, 12 and
      13 and confirm existing bots still answer and post, before the runner slices that call them
      (10, 15, 16) merge to `main`.
- [ ] **[HUMAN ACTION]** Per bot, after the cutover as in the design doc: `centaur bot add <bot>
      --platform slack`, a Slack app event URL change, `centaur admin claim <bot> --platform slack`
      and a test message on each live bot. If `garden-slack` exists, fold it in with
      `centaur bot adopt` and merge or close its open `centaur/garden-slack-*` pull requests first.
- [ ] **[HUMAN APPROVAL]** After a soak, unbind and remove the old Slack-only bot and its config.
- [ ] Platforms 20: delete the one-time migration code once the cutover has soaked and every
      consumer config and bot is migrated. The migration tooling (slice 4) is a lot of code for a
      single use: remove `bot migrate` (copy, verify, `--prune`, `--alias-platform`,
      `--drop-alias`), `config migrate` with its line-splicing and the `diff` dependency, and
      `bot adopt` if nothing else uses it, plus their tests, fixtures and `docs/cli.md` entries;
      reword the legacy-key error in `src/config/schema.ts`, which points at `centaur config
      migrate`, to say the key was removed. Decide then whether `bot export` and `bot restore`
      stay as a general backup. Check the Lambda and CLI bundles and `yarn install --immutable`
      afterwards. **[HUMAN APPROVAL]** to start, since it deletes the way back for a rollback.
- [ ] Live checks on the test bot (slice 19). Verified 2026-11-24: Telegram deleted-topic and
      not-a-forum strings, a closed topic accepting admin-bot posts (no reopen needed), Slack
      `channel_not_found` and `not_in_channel`, and a reply under a deleted Slack parent succeeding
      silently (see [docs/poster.md](docs/poster.md)). Also verified 2026-11-24: a persistent
      Telegram prompt (`hello-telegram`) bound its thread on the first run, and the second run
      reused it (one `thread-meta` record refreshed, no new thread, destination record unchanged).
      Remaining: a persistent run on Slack (no prompt here uses it yet), the `TOPIC_CLOSED` text for
      a bot without topic rights, and `is_archived` for a bot that is a member of an archived
      channel.
- [x] Platforms 21: config simplification (design Decision 19, maintainer ruling 2026-11-23): remove
      the prompt-level `platforms` selector; a string `destination` is valid only for a bot with one
      platform, a bot with several uses `destination: { <platform>: <name> }`. Updates
      `docs/config.md`, tests and the self-consumer config. Built independent of the other slices;
      merged to `main` and not yet pushed. No consumer config used the selector.
- [x] **[HUMAN APPROVAL]** The recommended `thread` semantics in Decision 19 (`new` never reuses a
      bound thread; a record bound to a topic with a `new` prompt posts a fresh thread; `persistent`
      on a record with no thread creates and binds one; `thread` applies to every fan-out target;
      `persistent` rejected by the schema until slice 16).

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
- [x] Create a DONE.md file, and move sections of fully-completed TODO items into DONE.
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
- [ ] `centaur chat tail <bot> [--platform <platform>] [--minutes <n>]`: a read-only CLI command
      that lists a bot's recent messages from the state table through the poster's reader and
      sender filter, so verifying a live run needs no ad hoc scans or Slack API calls
- [ ] **[HUMAN APPROVAL]** A read-only IAM role for inspection, limited to `GetItem`/`Query`/`Scan`
      on the state table and `ssm:Get*` on `/centaur/bots/*`, so agents stop using the
      maintainer's broad IAM user (a CloudFormation change, validated with `yarn lint:cfn`)

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
