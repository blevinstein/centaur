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

## 17. Chat context tools

- [ ] Chat context tools: let the agent read other threads in its chat through a built-in MCP server
      backed by new poster operations. Design and recommendations:
      [docs/chat-context.md](docs/chat-context.md); **[HUMAN APPROVAL]** accept or amend its
      Decisions before building.
  - [x] Config key, poster operations, platform support and the MCP server (steps 1 to 4).
  - [x] Poster-backed client, stdio entry (`dist/mcp/chat-server-main.js`), `prepare` wiring and
        prompt block (step 5); `scope: thread` is unchanged.
  - [x] Tool gate (step 6): the per-call MCP policy
        ([docs/proposals/mcp-tool-policy.md](docs/proposals/mcp-tool-policy.md)) is built, with a
        test that a `forbid` on `centaur-chat` is honored. It installs only when `mcp_servers` is
        non-empty, so a config with only the chat server has no gate.
  - [x] Chat context 7 real run: moved to Backlog 2026-11-26 as an optional manual check.
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
  - [ ] Chat search 4: Slack-native search. Design proposed in
        [docs/chat-search.md](docs/chat-search.md#slice-4-decisions-proposed); the design was approved
        2026-11-26 (nothing retrieved from Slack is stored beyond the short-lived token). Agent slices, in order (stop after 4.4 if its stop conditions hold):
    - [x] 4.1 Receiver captures the `action_token` into the state table (TTL, never logged). Merged
          as a7f0259.
    - [x] 4.2 Poster `search-chat` operation (caller check, public-channel and sender filters, clip,
          `unavailable` results, client method). Merged as a7f0259.
    - [ ] **[HUMAN ACTION]** 4.3 Deploy 4.1 and 4.2; reinstall the Slack app so the token has
          `search:read.public` (the manifests already list it; see
          [onboarding](docs/onboarding.md#slack-personal-projects)).
    - [ ] **[HUMAN ACTION]** 4.4 Live check: token present in real events, its lifetime, rate
          limits, works without `features.agent_view`, `in:` filter syntax, AI-feature
          availability; also confirm run logs do not count as storing results.
    - [ ] 4.5 MCP `search_chat` tool, registered only with `chat_tools.slack_search`.
    - [ ] **[HUMAN ACTION]** 4.6 Enable `slack_search: true` on one bot and run the end-to-end
          check.
  - [x] Chat search 5: the stored-history window, tracked in the next item.
  - [ ] **[HUMAN ACTION]** Chat search 6: verify the Telegram window cost on a real install (the
        Slack items moved to 4.4).
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
      1. [x] Nested guides under the root: abandoned 2026-11-26: nested guides are not supported.
      2. Two bots in shared Slack and Telegram chats: a message to both (the `client_payload.bot`
         filter and concurrency groups). Needs messages from the maintainer: the queen cannot
         puppet `centaur-test` (`centaur-o7u`).
- Decided 2026-11-25: auto-detecting sub-folder bots is not wanted; the explicit `root` input stays.

## Needs triage

Some of these are items that can be implemented in a single task; others require planning and
discussion before implementation. If a task has many subtasks, break it out into its own section
for detailed tracking.

- [x] Move not-yet-implemented docs into a proposals/ subdir to separate from already-implemented.
- [x] Create a DONE.md file, and move sections of fully-completed TODO items into DONE.
- [x] Set up a `.centaur` config for a personal-finance repo: a budgeting-app integration and
      periodic reviews. Set up with a read-only budgeting-app connection, a weekly liquidity review
      and a quarterly review (2026-11-26).
- [x] Centaur-provided prompt instructions explaining harness quirks etc, and merging harness
      instructions with AGENTS.md and the situational prompt. Proposal:
      [docs/proposals/harness-instructions.md](docs/proposals/harness-instructions.md).
  - [x] **[HUMAN ACTION]** Live check: the trusted `CLAUDE.md` did not reach a comment turn under
        `--setting-sources user` (2026-11-26), so delivering it is a fix.
  - [x] Delivery channel decided (2026-11-26): copy the trusted file into `$HOME/.claude/CLAUDE.md`.
        Built as the `repository_instructions` key (the Centaur root's guide; with
        `include_repo_root`, the repo-root guide first, under one cap).
  - [x] **[HUMAN ACTION]** Live check the copy (2026-11-26): a comment turn showed the agent received
        both guides, so Claude Code reads `$HOME/.claude/CLAUDE.md` under `--setting-sources user`.
        It did not show the `<!-- from -->` labels: Claude Code strips HTML comments.
  - [x] ~~**[HUMAN ACTION]** Recheck after the push: labels are now `# Instructions from <path>`
        headings; ask the agent on a comment turn to name both headings.~~ Abandoned 2026-11-26:
        the earlier live check showed the agent receives both guides.
  - [x] `scheduled.md`: the scheduled turn's own role text (proposal step 2, part).
  - [x] ~~`harness.md` and turn facts (proposal steps 2 and 4).~~ Abandoned 2026-11-26: covered by
        the role files and the generated prompt sections.
- [x] Better guides - basic response-only bot, adding scheduled actions
- [x] Support for centaur in a sub-folder? Explored and planned in
      [docs/proposals/subfolder-support.md](docs/proposals/subfolder-support.md); slices 1 to 4 are
      built, the live check is tracked in section 20.
- [x] `centaur chat tail <bot> [--platform <platform>] [--minutes <n>]`: a read-only CLI command
      that lists a bot's recent messages from the state table through the poster's reader and
      sender filter, so verifying a live run needs no ad hoc scans or Slack API calls. Done.
- [x] **[HUMAN APPROVAL]** A read-only IAM role for inspection, limited to `GetItem`/`Query`/`Scan`
      on the state table and `ssm:Get*` on `/centaur/bots/*`, so agents stop using the
      maintainer's broad IAM user (a CloudFormation change, validated with `yarn lint:cfn`).
      Merged as `InspectionRole` in `infra/centaur.yml` (dca2d8e, see `docs/deploy.md`) and deployed
      (2026-11-26). Callers also need `sts:AssumeRole` on it.

## Backlog

Every item here is **[HUMAN APPROVAL]**: do not start one without the maintainer saying so.

- [ ] Optional manual check, Execution 3 real run (**[HUMAN ACTION]**; decided 2026-11-26 to
      backlog): `direct` on a scratch repo, including the fall back to a pull request. Partly done
      on the self-consumer repo (`centaur-test-2`, since reverted; see
      [two-bot-test.md](docs/proposals/two-bot-test.md)). Verified: an unprotected branch accepts
      the direct push; the commit carries the run-URL footer and is unsigned; the `GITHUB_TOKEN`
      push triggers no workflow.
      Still open: rejection by a protected branch (`push_rejected` fallback pull request), a ruleset
      bypass actor, and the protected-path fallback.
      The maintainer asked both bots to edit the test bot's persona (a protected path); both refused at
      the persona level, so the harness never saw a diff and the protected-path fallback is still
      covered only by unit tests on real git repos. Exercising it live needs a bot whose persona allows
      editing a protected path (for example on a scratch repository).
- [ ] Optional manual check, skill-body retention across turns of a prompt with `context: resume`
      (**[HUMAN ACTION]**; backlogged 2026-11-26): on Telegram (`/resume` works there), or via a
      scheduled or test prompt whose config sets `context: resume`, check that a skill invoked on an
      earlier turn keeps its body on the next turn (steps in
      [two-bot-test.md](docs/proposals/two-bot-test.md#live-checks-skills-resume)). Separately
      unexplained: the `last-processed` marker did not advance on later turns of the earlier run
      (bead filed).
- [ ] Branch protection for `main` and required reviewers on `production` (decided 2026-11-26 to
      backlog; manual). The `production` environment already limits deploys to `main`; requiring
      pull requests would also stop direct pushes to `main`.
- [ ] The receiver reads every bot, with its token and secrets, once per Lambda container
      (`createReceiver`), so a new bot or a changed token is ignored until the container restarts.
      Reload bots when a request names an unknown bot or a platform call fails with an auth error,
      or cache them with a short TTL like the parameter store wrapper. It bit the second-bot setup
      on 2026-11-26: the receiver 404s a bot with no `bots/<bot>/repo` binding until the warm
      environment is replaced; a deploy was the workaround.
- [x] Per-call MCP policy: filter MCP tool calls by argument (for example a mutating
      tool only for selected IDs) with a `CallTool` Cedar action, evaluated per call by a Claude
      Code `PreToolUse` hook, failing closed. Design, the catalogue of ways a misconfiguration could
      grant too much, and the hardening steps (schema validation, literal lint, exit-2 hook
      contract, post-run audit, settings isolation, dry-run command):
      [docs/proposals/mcp-tool-policy.md](docs/proposals/mcp-tool-policy.md). Built 2026-11-26 after a live probe of the hook (see the proposal). Open follow-ups: probe whether an agent with `Bash` can disable the gate through user-scope settings, and install the gate for configs with only the chat server.
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
  - [x] Both self-test bots set `bot_messages: mention` on Slack (Telegram stays `ignore`) and
        each bot's Slack user ID is approved on the other bot.
  - [x] Bot-to-bot mention (2026-11-26): `centaur-slack` mentioned `centaur-test-2` in the shared
        test channel; `centaur-test-2` answered in the thread within about 40 seconds, the other
        bot's copy was skipped by its bot filter, and the reply (no mention) was ignored, so no
        loop. Not covered: the reverse direction (same path, settings and approval) and a
        deliberate loop. See
        [docs/proposals/two-bot-test.md](docs/proposals/two-bot-test.md#bot-to-bot-mentions).
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [x] Contribute the DynamoDB state adapter upstream. Chat SDK declined it and points to community
      packages; Centaur uses the published `@blevinstein/chat-state-dynamodb` instead (see
      `docs/research.md`).
- [x] Bump `@blevinstein/chat-state-dynamodb` to 0.4.0 (adapter rejects calls before `connect()`);
      `connectState` already connects every adapter the Lambda creates.
- [x] Run a security audit to explore weaknesses and fix vulnerabilities. Done 2026-11-26; the open findings are the triage list in
      [docs/HEALTH_REPORT.md](docs/HEALTH_REPORT.md).
- [ ] Hosted option (BYOKs, central AWS infra instead of self-hosted). Proposal:
      [docs/proposals/hosted.md](docs/proposals/hosted.md). Deferred 2026-11-25; no deeper plans for
      now. The poster caller check (its slice 1) is implemented (section 21 in [DONE.md](DONE.md)); self-hosted still
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
- [ ] Close the unbound-bot case of `get-mcp-policy` (section 21 in [DONE.md](DONE.md)): the operation now
      takes the config's bot and rejects a token whose repository is not the bot's bound repo, but a
      bot with no binding is still served, because `register` reads the policy before binding the
      repo's first bot. Close it by having `register` return the policy, or bind first with
      rollback. Backlogged 2026-11-25: the global policy is a non-secret ceiling in a public file
      and only in-owner repos can read it; revisit before the global policy holds anything private
      or with hosted.

- [ ] Live checks on the test bot (slice 19, from section 16). Verified 2026-11-24: Telegram deleted-topic and
      not-a-forum strings, a closed topic accepting admin-bot posts (no reopen needed), Slack
      `channel_not_found` and `not_in_channel`, and a reply under a deleted Slack parent succeeding
      silently (see [docs/poster.md](docs/poster.md)). Also verified 2026-11-24: a persistent
      Telegram prompt (`hello-telegram`) bound its thread on the first run, and the second run
      reused it (one `thread-meta` record refreshed, no new thread, destination record unchanged).
      Remaining: a persistent run on Slack (no prompt here uses it yet), the `TOPIC_CLOSED` text for
      a bot without topic rights, and `is_archived` for a bot that is a member of an archived
      channel.
- [ ] **[HUMAN ACTION]** Optional manual check (Chat context 7, from section 17): real run on `centaur-hello` (or `centaur-test`) in each
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
- [ ] **[HUMAN ACTION]** Approvers live check: a second account sends the bot `approver request`
      in a direct message, the admin approves it, and `centaur approvers list` shows them; the
      admin tries `approver add` by Telegram reply and by Slack mention, and the approver can
      decide an MCP request and then `approver leave`. Not run yet: it needs a second account. The
      admin-only and MCP approval flows are verified live; this one has not been run, so until it
      is, the approver feature ([docs/approvers.md](docs/approvers.md)) is covered by tests only.
- [x] Optional: `centaur mcp approve <bot> <server>` pre-approves the exact definition in the
      default-branch config before its first turn (decision 9 of
      [docs/mcp-allowlist.md](docs/mcp-allowlist.md)). Writes the existing approval record; deploys
      nothing. Add it to `docs/cli.md`. It would let an operator approve a server without waiting
      for the first turn's request.
- [ ] Poster MCP tool for mid-turn questions and progress messages (status: proposal,
      [docs/proposals/mid-turn-tool.md](docs/proposals/mid-turn-tool.md); builds on the
      `centaur-chat` MCP server in [docs/chat-context.md](docs/chat-context.md)). It would let a
      long turn post a progress message before it finishes; questions end the turn with a reply.
- [ ] Redact slash-command text in the Chat SDK error logs. When a slash command handler throws
      (for example the admin claim command, whose argument is a one-time claim code) or the SDK
      logs an error, the command text can appear in the Lambda's error logs; found live when an
      admin claim code showed up in an error log. Find where the SDK logs the failing event (the
      logger passed to `createBotChat`/`createChat` in `src/lambda/chat.ts` and
      `src/lambda/handler.ts`) and wrap it to redact slash-command text, arguments and any `text`
      field of command payloads before it is written. Add a test with a command carrying a
      claim-code-shaped argument, and check the admin-claim flow is unaffected. Protects one-time
      claim codes and command arguments in CloudWatch logs.
