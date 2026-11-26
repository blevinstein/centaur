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
- [x] **[HUMAN ACTION]** Onboard one personal-project repo on Slack: create the app from the
      manifest once it exists, install it, store its secrets, invite the bot. Done: a
      personal-project repo runs on its own app and channel. Top-level messages get a reply with
      `respond_to: all`, and a thread reply continues the thread.
- [x] **[HUMAN ACTION]** Measure the Slack webhook acknowledgement time; Slack expects a 200 within
      about 3 seconds. Receiver durations over a sample: 120 ms to 1.8 s warm, 2.5 s total for a
      cold start including 0.7 s init. All are under the limit; the cold start has the closest
      margin.
- [ ] If the 3-second limit is missed, acknowledge first and finish the reaction and dispatch in
      the background. Not needed so far.

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
- [x] Rank PR candidates by update time instead of number if busy repos show stale ones.
- [x] Investigate the intermittent failure in `test/chat-dynamodb-state.test.ts` ("drops the oldest
      queued message beyond maxQueueSize").
- [x] Move the security-relevant parts of the turn state out of the workspace, since the agent can
      edit `.centaur-turn/state.json`. The whole file moved to `$RUNNER_TEMP/centaur-turn/` (every
      field steers a trusted step); a `Bash` tool in `allowed_tools` can still reach it, see
      docs/workflows.md "Turn state".

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
- [x] **[HUMAN APPROVAL]** After a week's soak, `centaur bot migrate --prune` (deletes the flat
      parameters and aliases) and delete the export file. Done 2026-11-23 without a soak; flat parameters pruned.
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
- [x] **[HUMAN APPROVAL]** Deploy the Lambda (`yarn deploy-prod`) after each of slices 9, 11, 12 and
      13 and confirm existing bots still answer and post, before the runner slices that call them
      (10, 15, 16) merge to `main`.
- [ ] **[HUMAN ACTION]** Per bot, after the cutover as in the design doc: `centaur bot add <bot>
      --platform slack`, a Slack app event URL change, `centaur admin claim <bot> --platform slack`
      and a test message on each live bot. Adding a platform to a bot is `bot add --platform`,
      nothing else.
- [ ] **[HUMAN APPROVAL]** After a soak, unbind and remove the old Slack-only bot and its config.
- [x] Platforms 20: delete the one-time migration code once the cutover has soaked and every
      consumer config and bot is migrated. The migration tooling (slice 4) is a lot of code for a
      single use: remove `bot migrate` (copy, verify, `--prune`, `--alias-platform`,
      `--drop-alias`), `config migrate` with its line-splicing and the `diff` dependency, and
      `bot adopt` if nothing else uses it, plus their tests, fixtures and `docs/cli.md` entries;
      reword the legacy-key error in `src/config/schema.ts`, which points at `centaur config
      migrate`, to say the key was removed. Decide then whether `bot export` and `bot restore`
      stay as a general backup. Check the Lambda and CLI bundles and `yarn install --immutable`
      afterwards. **[HUMAN APPROVAL]** to start, since it deletes the way back for a rollback. Done 2026-11-23.
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

## 17. Chat context tools

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
        platform with `chat_tools: { scope: chat }` on the default branch (set in `apps/centaur-test/.centaur/config.yml`). Telegram forum group,
        then Slack channel; in each:
        1. In thread A say: "We decided the garden party is Saturday at 6pm and we need tomatoes
           and basil."
        2. In thread B (a new topic or a reply to a different top-level message) say: "Summarize
           what was decided about the garden party in the other thread."
        3. Expect the reply to give Saturday, 6pm, tomatoes and basil. The run's execution log
           should show `list_threads` and `read_thread` on `mcp__centaur-chat__*` and the
           `centaur-chat` server connected; the job log, step outputs and PR text must show no
           message text, thread ID or chat ID.
        4. Ask in thread B: "Add that summary to a file in the repo." Expect the agent may use the
           cross-thread content.
        5. Set `scope: thread` again and repeat step 2: no `centaur-chat` server or tool calls.
        Slack steps 1 to 3 are verified: the reply gave Saturday, 6pm, tomatoes and basil, and the
        run log held no message text, thread ID or chat ID (it does not name the tools either).
        Step 4 changed after Slack showed the agent declining to put cross-thread content in a pull
        request description; that prompt rule is gone and the check now expects the content to be
        usable. Left: step 4, Telegram, step 5 on both platforms, and the rate limits.
        Also confirm the Slack `conversations.history` and `conversations.replies` rate limits
        hold on this install (see Chat search 6).
- [x] Telegram chat tools miss the bot's own posts and bot-only threads. Done: option A. The poster
      records each sent message in the chat's list (`postInThread`, `src/lambda/channel-history.ts`),
      and the readers (`read-channel`, `list-threads`, `centaur chat tail`) now read that list
      through `chat.history.thread.collect(channelId)`, because the SDK's `chat.channel(id).messages`
      never reads the stored list (the Telegram adapter's `fetchChannelMessages` compares
      `decoded.chatId` with `telegram:<chatId>`). Posts made before this deploy stay thread-only.
  - [x] (A) Append the sent message to the chat list after `post` and `start-thread`.
  - [x] (B) Not needed.

## 18. Chat search

- [x] Chat search: the Chat SDK has no history search, so any search is ours. Decisions accepted
      2026-11-22 ([docs/chat-search.md](docs/chat-search.md)): no poster-side filter (the poster
      scans the whole window and the Telegram window fits in one call), report the scanned range,
      and add opt-in Slack-native search; no secondary index (SQLite FTS, OpenSearch, embeddings)
      because of the infrastructure cost. Slices, in order:
  - [x] Chat search 1: `scanned: { oldest, exhausted }` range in `read-channel` and
        `list-threads` results.
  - [x] Chat search 2: `chat_tools` config key for the Slack search opt-in.
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

## 19. Agent skills

Design and decisions: [docs/skills-rules.md](docs/skills-rules.md).

- [x] **[HUMAN APPROVAL]** Accept the decisions in [docs/skills-rules.md](docs/skills-rules.md):
      all nine accepted as recommended.
- [x] Built-in skills `skills/centaur-{reactions,mcp-approval,thread-commands,pull-requests,chat-tools}`,
      each statement checked against the code.
- [x] `installSkills` (`src/workflows/skills.ts`), the `CENTAUR_SKILLS_DIR` env on the turn action,
      consumer skill validation from the trusted checkout.
- [x] `skills: { builtin, consumer }` config key, `Skill` in `--allowedTools`, comment turns pass
      `--setting-sources user`.
- [x] `description` strings on the `replySchema` fields, a "Skills" prompt section, the chat tools
      detail moved out of `chat_tools.md`.
- [ ] **[HUMAN APPROVAL]** Deploy the Lambda that knows the `skills` key (`yarn deploy-prod`) before
      any consumer's default branch sets `skills`; then check the `register` run. Consumers that do
      not set the key need no change.
- [x] Live check of the built-in skills on an `experiment/*` branch (2026-11-24): discovery,
      invocation, the consumer-skill name (`centaur-consumer-<folder name>`) and the comment-turn
      trust check (branch-committed skills are not visible) are done and recorded in
      [docs/skills-rules.md](docs/skills-rules.md#live-check-results).
- [ ] **[HUMAN ACTION]** Remaining live-check points (see the same section): the resume check (two
      chat messages from the maintainer in one `resume` thread: is the invoked skill body
      retained?); whether `Skill` must be in `--allowedTools` (run without it; harmless to leave);
      (The trusted `CLAUDE.md` question under `--setting-sources user` is answered: it does not
      reach a comment turn on its own; see the harness instructions item in Needs triage.)

## 20. Sub-folder support

Design: [docs/proposals/subfolder-support.md](docs/proposals/subfolder-support.md).

- [x] Sub-folder 1 to 4: `resolveRoot` and root-aware config discovery, the root read in `prepare`
      (project-folder line in the prompt), the MCP policy path, `register` and `config check`, the
      `root` input on the actions, and the multi-bot workflow guidance.
- [ ] **[HUMAN ACTION]** Sub-folder 5, live check on a scratch monorepo with two sub-folder bots.
      Partly done 2026-11-26 on the self-consumer repo (`apps/centaur-test` and `apps/centaur-test-2`).
      Verified: a sub-folder bot registers (a matrix per root); a scheduled prompt and a comment
      turn run on a sub-folder root; with two bots in one repo, each comment is answered by exactly
      one workflow (the other copy's turn is skipped). Note: Claude Code strips HTML comments from
      the guide, so guide labels are headings.
      Still open:
      1. A nested `AGENTS.md` or `CLAUDE.md` under the root loads lazily when the agent reads files
         in that folder, in addition to the explicit prompt instruction.
      2. Two bots in shared Slack and Telegram chats: a message to both (the `client_payload.bot`
         filter and concurrency groups).
      Then finish the docs wrap-up in `docs/config.md` (location section).
- Decided 2026-11-25: auto-detecting sub-folder bots is not wanted; the explicit `root` input stays.

## 21. Poster caller check

Implemented: the poster verifies the caller's GitHub OIDC token on `post`, `unreact`,
`start-thread` and `get-mcp-policy` ([docs/poster.md](docs/poster.md#security-model)).

- [ ] **[HUMAN APPROVAL]** Deploy the Lambda (`yarn deploy-prod`) with the caller check and the
      inspection role. Deploy before the runner change reaches consumers pinned to `main`: an older
      Lambda rejects the new `token` field.
- [ ] **[HUMAN APPROVAL]** Set `RequirePosterToken=true` once the Lambda's "poster call without a
      token" warnings stop. Rollback: set it to `false` and redeploy.
## 22. Execution modes

Design and decisions (2026-11-25): [docs/proposals/execution-modes.md](docs/proposals/execution-modes.md).
`direct` is allowed on chat and scheduled turns, opt-in per bot; no `execution.branch`; authorization
is config only; one retry, then fall back to a pull request; the run URL goes in the footer; try
the push and fall back.

Rollout rule: the `execution` key must not reach a consumer's default branch before the Lambda that
parses it is deployed, so it needs the deploy approval first (section 21).

- [x] Execution 1: config block `execution` and docs.
- [x] Execution 2: extract the transplant from `push-existing.ts` and add `pushDirect`.
- [x] Execution 3: wire the `turn` action (`plan-pr` generalization, `push-direct`).
- [ ] **[HUMAN ACTION]** Execution 3 real run: `direct` on a scratch repo, including the fall back
      to a pull request. After 3. Partly done on the self-consumer repo (`centaur-test-2`, since
      reverted; see [two-bot-test.md](docs/proposals/two-bot-test.md)). Verified: an unprotected
      branch accepts the direct push; the commit carries the run-URL footer and is unsigned; the
      `GITHUB_TOKEN` push triggers no workflow.
      Still open: rejection by a protected branch (`push_rejected` fallback pull request), a ruleset
      bypass actor, and the protected-path fallback.
- [ ] Execution 4: prompt text and `replySchema` fields for the mode.

## 23. Continuous deployment

Workflows `ci.yml` and `deploy.yml`, `DeployRole` in `infra/centaur.yml` and the setup are
described in [docs/deploy.md](docs/deploy.md#continuous-deployment). Decided 2026-11-26: the role
lives in the main stack, every push to `main` deploys through the `production` environment (no
required reviewer), and a dispatch redeploys a chosen ref.

- [ ] **[HUMAN ACTION]** Before merging or pushing: `scripts/setup-cd.sh environment`. Unrestricted,
      the `production` environment lets any branch's workflow assume the role.
- [ ] **[HUMAN APPROVAL]** Merge and push (the first `deploy` job fails harmlessly at credentials),
      then deploy by hand (`yarn deploy-prod`) from the merged commit, reviewing the change set
      (existing roles gain a permissions boundary) and smoke-testing both bots.
- [ ] **[HUMAN ACTION]** `scripts/setup-cd.sh credentials` (sets `DEPLOY_ROLE_ARN` and
      `DEPLOY_PARAMETERS`; `CENTAUR_AWS_REGION` must already exist).
- [ ] **[HUMAN APPROVAL]** Run the `Deploy` workflow to confirm it assumes the role. If it fails to
      assume it, check the `sub` formats in the doc.
- [ ] **[HUMAN APPROVAL]** Decide on branch protection for `main` and required reviewers on
      `production` (manual; requiring pull requests also stops direct pushes to `main`).

## Needs triage

Some of these are items that can be implemented in a single task; others require planning and
discussion before implementation. If a task has many subtasks, break it out into its own section
for detailed tracking.

- [x] Move not-yet-implemented docs into a proposals/ subdir to separate from already-implemented.
- [x] Create a DONE.md file, and move sections of fully-completed TODO items into DONE.
- [ ] Setup .centaur config for ~/dev/finances repo - monarch integration, consider using ledger for
      selected transactions (or link to gsheets), weekly transaction review and liquidity check
      (knows which credit card balances are paid from which bank accounts), quarterly investment/
      insurance/plan review
- [ ] Setup .centaur config for ~/dev/resume repo - e.g. exploring new business opportunities,
      responding to recruiter emails, looking for consulting opportunities, etc
- [ ] Centaur-provided prompt instructions explaining harness quirks etc, and merging harness
      instructions with AGENTS.md and the situational prompt. Proposal:
      [docs/proposals/harness-instructions.md](docs/proposals/harness-instructions.md).
  - [x] **[HUMAN ACTION]** Live check: the trusted `CLAUDE.md` did not reach a comment turn under
        `--setting-sources user` (2026-11-26), so delivering it is a fix.
  - [x] Delivery channel decided (2026-11-26): copy the trusted file into `$HOME/.claude/CLAUDE.md`.
        Built as the `repository_instructions` key (repo-root guide, then the Centaur root's, under
        one cap).
  - [x] **[HUMAN ACTION]** Live check the copy (2026-11-26): a comment turn showed the agent received
        both guides, so Claude Code reads `$HOME/.claude/CLAUDE.md` under `--setting-sources user`.
        It did not show the `<!-- from -->` labels: Claude Code strips HTML comments.
  - [ ] **[HUMAN ACTION]** Recheck after the push: labels are now `# Instructions from <path>`
        headings; ask the agent on a comment turn to name both headings.
  - [ ] `harness.md`, `scheduled.md` and turn facts (proposal steps 2 and 4).
- [ ] Setup .centaur config for ~/dev/turo-accounting repo - try to use playwright to integrate
      with Turo admin portal?
- [x] Better guides - basic response-only bot, adding scheduled actions
- [x] Support for centaur in a sub-folder? Explored and planned in
      [docs/proposals/subfolder-support.md](docs/proposals/subfolder-support.md); slices 1 to 4 are
      built, the live check is tracked in section 20.
- [x] `centaur chat tail <bot> [--platform <platform>] [--minutes <n>]`: a read-only CLI command
      that lists a bot's recent messages from the state table through the poster's reader and
      sender filter, so verifying a live run needs no ad hoc scans or Slack API calls. Done.
- [ ] **[HUMAN APPROVAL]** A read-only IAM role for inspection, limited to `GetItem`/`Query`/`Scan`
      on the state table and `ssm:Get*` on `/centaur/bots/*`, so agents stop using the
      maintainer's broad IAM user (a CloudFormation change, validated with `yarn lint:cfn`).
      Merged as `InspectionRole` in `infra/centaur.yml` (see `docs/deploy.md`); not deployed yet,
      the deploy is in section 21. Callers also need `sts:AssumeRole` on it.

## Backlog

Every item here is **[HUMAN APPROVAL]**: do not start one without the maintainer saying so.

- [ ] The receiver reads every bot, with its token and secrets, once per Lambda container
      (`createReceiver`), so a new bot or a changed token is ignored until the container restarts.
      Reload bots when a request names an unknown bot or a platform call fails with an auth error,
      or cache them with a short TTL like the parameter store wrapper. It bit the second-bot setup
      on 2026-11-26: the receiver 404s a bot with no `bots/<bot>/repo` binding until the warm
      environment is replaced; a deploy was the workaround.
- [ ] Per-call MCP policy (proposal): filter MCP tool calls by argument (for example a mutating
      tool only for selected IDs) with a `CallTool` Cedar action, evaluated per call by a Claude
      Code `PreToolUse` hook, failing closed. Design, the catalogue of ways a misconfiguration could
      grant too much, and the hardening steps (schema validation, literal lint, exit-2 hook
      contract, post-run audit, settings isolation, dry-run command):
      [docs/proposals/mcp-tool-policy.md](docs/proposals/mcp-tool-policy.md). A first cut with tests, not yet hardened,
      is on the branch [`proposal/mcp-tool-policy-first-cut`](https://github.com/blevinstein/centaur/tree/proposal/mcp-tool-policy-first-cut). Needs a live experiment first (**[HUMAN ACTION]** to approve
      the `experiment/*` run).
- [ ] Plan for long-running agent turns (>15 mins). Turns run on the runner, so the real limits are
      the job's `timeout-minutes` and cost, not a Lambda limit. This may happen if we are using MCP
      tools etc which take a while to respond. Approval waits are handled by suspend and resume
      ([docs/mcp-approval.md](docs/mcp-approval.md#suspend-and-resume)).
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
- [x] Test how a turn behaves when `--max-budget-usd` stops a run before a structured reply.
- [ ] Two bots in one group: routing is now guarded (2026-11-26: `ownsMessage` ignores
      bot-authored messages in every mode, and the second bot `centaur-test-2` exists on Slack and
      Telegram). Still to confirm live (**[HUMAN ACTION]**): messages to both bots in one shared
      Slack channel and Telegram group route to the right bot and do not loop.
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [x] Contribute the DynamoDB state adapter upstream. Chat SDK declined it and points to community
      packages; Centaur uses the published `@blevinstein/chat-state-dynamodb` instead (see
      `docs/research.md`).
- [x] Bump `@blevinstein/chat-state-dynamodb` to 0.4.0 (adapter rejects calls before `connect()`);
      `connectState` already connects every adapter the Lambda creates.
- [ ] Run a security audit to explore weaknesses and fix vulnerabillities
- [ ] Hosted option (BYOKs, central AWS infra instead of self-hosted). Proposal:
      [docs/proposals/hosted.md](docs/proposals/hosted.md). Deferred 2026-11-25; no deeper plans for
      now. The poster caller check (its slice 1) is implemented (section 21); self-hosted still
      accepts tokenless calls until `RequirePosterToken=true`, and a hosted option needs a
      reserved-concurrency cap on the function.
  - [ ] Answer its open questions (product or friends-and-family beta, central GitHub App with
        Contents write versus `workflow_dispatch`, adapter `tenant` attribute versus a new key
        layout, HTTPS poster transport for self-hosted, region, retention, operator MCP policy,
        pricing, model key as a GitHub secret, publishing the actions).
  - [ ] Hosted slice 2: HTTPS poster transport and presigned session access.
  - [ ] Hosted slice 3: tenant-scoped storage (`keyPrefix`, S3 key builder, adapter `tenant`
        attribute and GSI).
  - [ ] Hosted slice 4: DynamoDB parameter store with envelope-encrypted secrets, lookup by `botId`.
  - [ ] Hosted slice 5: control plane (GitHub App, sign-in, tenant records, secret intake form,
        setup pull request, token minter).
  - [ ] Hosted slice 6: limits and edge (quotas, concurrency caps, WAF, alarms, runbooks).
  - [ ] Hosted slice 7: billing, legal documents, public sign-up.
- [ ] Email support as a platform (think about SMTP complexity). Proposal:
      [docs/proposals/email.md](docs/proposals/email.md). Deferred 2026-11-25; the first open
      question, whether inbox triage needs a platform at all (an MCP mail connector in a scheduled
      prompt may be enough), is unanswered.
- [ ] Close the `get-mcp-policy` gap (section 21): it is verified by token only and any valid
      in-owner token can read the global policy, because `register` reads it before binding the
      repo's first bot. Design options: bind first then check, with rollback on failure, or have
      `register` return the policy. Backlogged 2026-11-25: the global policy is a non-secret
      ceiling in a public file and only in-owner repos can read it; revisit before the global policy
      holds anything private or with hosted.

- [ ] **[HUMAN ACTION]** Approvers live check: a second account sends the bot `approver request`
      in a direct message, the admin approves it, and `centaur approvers list` shows them; the
      admin tries `approver add` by Telegram reply and by Slack mention, and the approver can
      decide an MCP request and then `approver leave`. Not run yet: it needs a second account. The
      admin-only and MCP approval flows are verified live; this one has not been run, so until it
      is, the approver feature ([docs/approvers.md](docs/approvers.md)) is covered by tests only.
- [ ] Optional: `centaur mcp approve <bot> <name>` pre-approves the exact definition in the
      default-branch config before its first turn (decision 9 of
      [docs/mcp-allowlist.md](docs/mcp-allowlist.md)). Writes the existing approval record; deploys
      nothing. Add it to `docs/cli.md`. It would let an operator approve a server without waiting
      for the first turn's request.
- [ ] Poster MCP tool for mid-turn questions and progress messages (builds on the MCP server
      config in [docs/mcp.md](docs/mcp.md)). It would let a long turn ask the thread a question or
      report progress before it finishes.
- [ ] Redact slash-command text in the Chat SDK error logs. When a slash command handler throws
      (for example the admin claim command, whose argument is a one-time claim code) or the SDK
      logs an error, the command text can appear in the Lambda's error logs; found live when an
      admin claim code showed up in an error log. Find where the SDK logs the failing event (the
      logger passed to `createBotChat`/`createChat` in `src/lambda/chat.ts` and
      `src/lambda/handler.ts`) and wrap it to redact slash-command text, arguments and any `text`
      field of command payloads before it is written. Add a test with a command carrying a
      claim-code-shaped argument, and check the admin-claim flow is unaffected. Protects one-time
      claim codes and command arguments in CloudWatch logs.
