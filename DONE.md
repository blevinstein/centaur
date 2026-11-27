# DONE

Completed sections, moved from [TODO.md](TODO.md) once every item in them was checked. Section numbers match TODO.md.

## 1. Validate the agent runtime

- [x] Run `anthropics/claude-code-action@v1` via `workflow_dispatch` on an `experiment/*` branch
      with a trivial prompt via the Anthropic API.
- [x] Run the same workflow through OpenRouter using its documented Action setup
      (`anthropic_api_key` plus `ANTHROPIC_BASE_URL`). If auth fails, try
      `ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer <key>"`. Record which works in
      `docs/research.md`.
- [x] Confirm `--json-schema` in `claude_args` produces a usable `structured_output` with a
      required `reply` field.
- [x] Capture `session_id`, find the session `.jsonl` under `~/.claude/projects/`, and confirm
      the escaped-cwd directory name is stable across runs.
- [x] Upload the session file to S3 using a GitHub OIDC role (no stored AWS keys), restore it in
      a second run, and confirm `--resume <session_id>` continues the conversation.
- [x] Note typical per-turn latency and token cost.

## 2. Decide open design questions

- [x] State backend: a DynamoDB `StateAdapter` (plan decision 1).
- [x] Where turns execute for public consumer repos: in each repo's own Actions (plan decision
      2).
- [x] GitHub credential for dispatch: fine-grained PAT, with a GitHub App as the upgrade path.

## 3. Infrastructure

- [x] Choose the language and tooling for the Lambda and CLI (TypeScript, to match Chat SDK) and
      set up the package with lint, typecheck, and tests.
- [x] Provide a DynamoDB `StateAdapter` for the Chat SDK (19 methods, see `docs/research.md`),
      now the published `@blevinstein/chat-state-dynamodb` package.
- [x] Run `Chat` end to end against the DynamoDB adapter on DynamoDB Local, checking how the
      core uses the `appendToList` TTL, `maxLength`, and expired queue entries.
- [x] Add the state table (mirroring the adapter's `TABLE_DEFINITION`: pay-per-request, TTL on `ttl`) and its
      IAM access to `infra/centaur.yml`; make `chat` a runtime dependency once a Lambda consumes
      the package.
- [x] CloudFormation template: receiver/poster Lambda with a function URL, state backend, S3
      session bucket, SSM parameter paths, and the GitHub OIDC provider and role. The role's
      trust is limited by a `GitHubOwner` parameter. The template imports nothing.
- [x] Deploy script that takes parameter overrides from the caller, so personal values stay in
      the deployer's private infra repo.

## 4. Receiver and poster

- [x] Convert Lambda function URL events to and from web `Request`/`Response` for Chat SDK
      webhook handlers.
- [x] Build the `Chat` instance from the registry and SSM secrets at cold start, with
      per-bot webhook paths (`/telegram/<bot>`, `/slack/<bot>`).
- [x] Admin-approved access per bot (chats and users, blocklist, access requests answered by
      reaction); reply to unknown senders with a refusal and log their IDs.
- [x] Message ownership rules for a shared Telegram group (bot-created topics, mentions,
      ignore the rest).
- [x] On an accepted message: 👀 reaction, then a `repository_dispatch` carrying IDs only.
- [x] Image attachments: the receiver stores images from enrolled senders in the session bucket,
      the poster's `read` lists their keys (and stores any that were missed), and `prepare` loads
      the newest 10 shown images into the turn (verified end to end on a Telegram photo).
- [x] Poster operations, invoked over IAM: post a reply, start a new thread or topic, read a
      thread transcript.
- [x] `register` operation: take the repo name from the OIDC claims, require existing bot
      secrets, refuse to rebind a bot owned by another repo, and call `setWebhook` for Telegram.

## 5. CLI

- [x] `centaur bot add|remove <bot> --platform <platform>`: store the token and generate the
      webhook secret in SSM.
- [x] `centaur bot list` and `centaur bot unbind <bot>` to inspect bots and release one from its repo.
- [x] `centaur admin set|show|remove|claim`, `centaur access approve|revoke|block|unblock|list`
      and `centaur chat list` for access and chat aliases.
- [x] `centaur github-token set|remove`.

## 6. Shared workflows

- [x] `register.yml` (`workflow_call`): parse `.centaur.yml` and invoke `register`.
- [x] `agent-turn.yml` (`workflow_call`):
  - [x] Read `.centaur.yml` and the thread's context policy.
  - [x] Assemble context for `fresh`, `transcript`, and `resume`.
  - [x] Process all messages since the thread's last-processed marker.
  - [x] Run the agent, post the reply via the poster, open a PR when files changed.
  - [x] Per-thread `concurrency` group.
  - [x] Keep message content out of logs and artifacts.
- [x] In-chat commands: `/new`, `/resume`, `/transcript`.
- [x] Define and validate the `.centaur.yml` schema.

## 7. End-to-end on Telegram

Deploying, the test bot, the scratch consumer repo and the first round trips are done.

- [x] **[HUMAN ACTION]** Deploy the stack (`parameters-prod.json`, OIDC provider check,
      `yarn deploy-prod`; see [docs/deploy.md](docs/deploy.md)).
- [x] **[HUMAN ACTION]** Create the test bot in BotFather, `centaur bot add`, store the GitHub PAT
      with `centaur github-token set`, create the Topics supergroup and add the bot as admin with
      Manage Topics.
- [x] **[HUMAN ACTION]** Claim the admin role (`centaur admin claim <bot>`) and approve the group.
- [x] **[HUMAN ACTION]** Set the test repo's variables and `ANTHROPIC_API_KEY` secret, enable "Allow
      GitHub Actions to create and approve pull requests", and confirm `bots/<bot>/repo` appears in
      SSM.
- [x] **[HUMAN ACTION]** Message the bot in a topic: message, dispatch, turn, reply (about 47 s from
      dispatch to posted reply: queue 4 s, runtime setup 7 s, agent 27 s, post 3 s).
- [x] **[HUMAN ACTION]** Run the scheduled prompt with `workflow_dispatch`; it opened a new topic.
- [x] **[HUMAN ACTION]** Reply in that topic without a mention; the transcript and last-processed
      marker advanced.
- [x] Repeat the `Chat`-against-DynamoDB run on the deployed table.
- [x] **[HUMAN ACTION]** Walk through [docs/onboarding.md](docs/onboarding.md) as written and
      report anything wrong.
- [x] **[HUMAN ACTION]** Report anything from the "Still unverified" list in `docs/onboarding.md`
      that breaks. Worked in the test repo: `execution_file` output shape, `repository_dispatch`
      with `claude-code-action`, and `vars` (caller and called workflow share a repo, so the
      cross-repo case isn't proven). Not exercised yet: the `job.workflow_*` contexts and a consumer
      in a different repo.

## 8. First consumer: `garden`

- [x] Add `.centaur.yml`, `.centaur/persona.md`, and `.centaur/prompts/weekly-tasks.md`.
- [x] Add the caller workflow with the Saturday schedule.
- [x] Update `garden`'s `AGENTS.md` so automated runs open PRs instead of pushing to `main`.
- [x] **[HUMAN ACTION]** Set the `ANTHROPIC_API_KEY` secret: `gh secret set ANTHROPIC_API_KEY -R
      <owner>/garden` and paste the key (agents can't copy secret values between repos).
- [x] **[HUMAN ACTION]** Create a second bot in BotFather, run `centaur bot add garden --platform
      telegram`, create the household group and enroll the household member.
- [x] **[HUMAN ACTION]** Onboard the household group: claim the admin role (`centaur admin claim
      <bot>`, open the link), mention the bot in the group, then approve the group and each user
      from the bot's DM.
- [x] **[HUMAN APPROVAL]** Garden PR #7: the first `weekly-tasks` run opened it with the old
      generic title. Merge or close it, then re-run `weekly-tasks` to check the agent-written title
      and body.
- [x] **[HUMAN APPROVAL]** Choose a license: MIT (`LICENSE`).

## 9. Follow-ups

- [x] Align alias naming: the CLI accepts aliases matching `[a-z0-9][a-z0-9-]*` but the config
      schema's prompt `destination` allows underscores, so such an alias cannot be created with
      `centaur access approve --alias`. Make the CLI and schema use one pattern (allowing `_` in
      the CLI is the smaller change) and update `docs/cli.md` and `docs/config.md`.
- [x] Close the first-registration race on `bots/<bot>/repo` with a conditional `PutParameter`.
- [x] Add a routing test for `src/lambda/handler.ts`.
- [x] Cache SSM reads in the receiver; each accepted message makes 1 to 3 SSM calls.
- [x] CLI: clearer error when piped stdin has too few lines (`Missing value for <name>.`).
- [x] Decide whether `destination` names are checked against SSM at register time. No (design
      Decision 16): with create on first use a name can be unresolved at register, so `register`
      checks only that each declared platform has a connection; names resolve when the run starts.
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
- [x] **[HUMAN APPROVAL]** Delete the old `garden` branches `centaur/garden-<raw thread ID>` and
      `centaur/garden-<raw thread ID>-13`; their names carried the raw thread ID, which
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

## 10. Decisions

- [x] **[HUMAN APPROVAL]** Transcript size bound. Decided: the earlier transcript fills at most 25%
      of the model's context window (`context.transcript_max_percent`, optional
      `context.window_tokens` override, polytokenizer lookup, 200,000 fallback), newest first, with
      oversized messages truncated and an omission note pointing at the chat context tools. Poster
      `read` is unchanged. Documented in `docs/plan.md`, `docs/workflows.md` and `docs/config.md`;
      implementation is section 15.
- [x] **[HUMAN APPROVAL]** Poster caller check and concurrency cap. Accepted for self-hosted use,
      where the maintainer controls the AWS account and every repo under the owner; to be revisited
      with the hosted option (per-repo token, reserved-concurrency cap). Documented in
      `docs/poster.md` ("Security model").

## 11. MCP support and approval

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
- [x] **Approval-required** MCP servers: implemented and checked live (2026-11-24); design:
      [docs/mcp-approval.md](docs/mcp-approval.md) (code in its
      [implementation map](docs/mcp-approval.md#implementation-map)). Slices:
  - [x] Approval 1: Cedar `context.approved`, two-pass `authorize`, fingerprint helper,
        `checkMcpPolicy` returning `{ issues, approvals }`, and the `config check` / `register`
        notices. No dependencies.
  - [x] Approval 2: the `mcp` access-request kind, decisions by reaction and `/approve` / `/deny`, the
        SSM record, the `mcp-denied` TTL record, IAM, and the re-dispatch when `suspended`. No
        dependencies (parallel with 1). **[HUMAN APPROVAL]** deploy of the Lambda and IAM change.
  - [x] Approval 3: poster `mcp-approvals` operation and `docs/poster.md`. Needs 2.
        **[HUMAN APPROVAL]** deploy of the Lambda change.
  - [x] Approval 4: `prepare` wiring (one `mcp-approvals` call per turn) and prompt lines. Needs 1 and 3.
  - [x] Approval 5: `suspend_for` field and the `finish` suspend. Needs 4.
  - [x] Approval 6: `centaur mcp approvals` list and `revoke`. Needs 2.
  - [x] **[HUMAN ACTION]** Approval live check, done on this repo's read-only GitHub server behind
        a `when { context.approved }` permit. Verified: the policy flags the server and `prepare`
        drops it until approved; a chat turn raises the request and the admin gets the DM; a 👍
        records the approval and the server is then used by a chat turn and by a scheduled prompt;
        a turn that suspends posts its reply and the admin's later decision resumes it, including a
        decision that lands before the suspend call; the status shows as a reaction instead of a
        post; `centaur mcp approvals` lists the approval and `centaur mcp revoke` removes it, after
        which the server is asked about again; run logs show no message text, thread ID, chat ID or
        token. The live check found and fixed six bugs (thread-less read on a multi-platform bot, a
        reply-less suspend, a stale pending slot, a decision before the suspend call, the poster's
        eager GitHub token read, and a shallow checkout). Not run live: a 👎 denial (it blocks the
        server for 7 days) and an edit of the server definition asking a new question; both are
        covered by tests.
- [x] Dropped as obsolete: offer to redo the original request after an approval. The agent now
      suspends and resumes on its own, so it only covered the rare case of an answer without a
      suspend.
- [x] Harden `isPinned` (`src/config/mcp-policy.ts`) against flags that take a value. It takes the
      first argument not starting with `-` as the package, so in `uvx --with pkg==1.0.0 other-pkg`
      the pinned-looking `--with` value hides the unpinned `other-pkg`, and in `uvx --python 3.12
      pkg==1.0` the version `3.12` is taken as the package (a false negative). For `uvx`, the
      target is the `--from` value when present, else the first positional argument; for `npx`, the
      package after its flags. Design first: which flags take a value per command, and fail closed
      (not pinned) on an unknown flag. A config change reviewed on the default branch is the only
      way to exploit it today, so it is defense in depth on the global ceiling.
- [x] Approvers: a group broader than the platform admin who can decide MCP approvals (and possibly
      access requests), authorized by the admin. Design and recommendations:
      [docs/approvers.md](docs/approvers.md); **[HUMAN APPROVAL]** accept or amend its Decisions
      before building.
  - [x] Approvers 1: set and gate (path helpers, `mayDecide`, audit). No dependencies.
  - [x] Approvers 2: fan-out of `mcp` requests to the admin and each approver, with the
        channel-keyed message link. Needs 1.
  - [x] Approvers 3: the `approver` request kind and `leave`, IAM write on the approvers path.
        Needs 1. **[HUMAN APPROVAL]** deploy of the Lambda and IAM change.
  - [x] Approvers 4: admin commands `add`, `remove`, `list` from chat. Needs 3.
  - [x] Approvers 5: `centaur approvers list|remove|add`. Needs 1 (path helpers).
  - [x] Approvers 6 (open `chat` or `user` requests to approvers) dropped as obsolete: it applied
        only if Decision 1 of `docs/approvers.md` were amended, and nothing depends on it.
  - [x] Approvers 7: fold the design's docs table (section 9) into plan, mcp-approval, cli and
        deploy. Needs 1 to 5.
- [x] Explore a way to update the MCP policy by adding entries to an allowlist. Decided
      ([mcp-allowlist.md](docs/mcp-allowlist.md)): no allowlist store; a generalized allow is a
      reviewed Cedar permit, any `forbid` wins; the permit cookbook in `docs/mcp.md` shipped.

## 12. Slack support

- [x] App manifest template with the required scopes and event URL
      ([docs/slack-app-manifest.yml](docs/slack-app-manifest.yml), steps in `docs/onboarding.md`).
- [x] **[HUMAN APPROVAL]** One Slack app per repo.
- [x] ~~Slack `/new`, `/resume` and `/transcript`.~~ Abandoned 2026-11-26, final: Slack does not
      support thread commands. Slack rejects a message that starts with `/` as an unknown command, a
      slash command never lands in channel history and can't target an existing thread, and no
      text-form workaround is wanted. Slack threads set the context policy with the prompt's
      `context` (`resume`, `transcript` or `fresh`) in the config. The commands stay on Telegram.
- [x] **[HUMAN ACTION]** Onboard one personal-project repo on Slack: create the app from the
      manifest once it exists, install it, store its secrets, invite the bot. Done: a
      personal-project repo runs on its own app and channel. Top-level messages get a reply with
      `respond_to: all`, and a thread reply continues the thread.
- [x] **[HUMAN ACTION]** Measure the Slack webhook acknowledgement time; Slack expects a 200 within
      about 3 seconds. Receiver durations over a sample: 120 ms to 1.8 s warm, 2.5 s total for a
      cold start including 0.7 s init. All are under the limit; the cold start has the closest
      margin.
- [x] ~~If the 3-second limit is missed, acknowledge first and finish the reaction and dispatch in
      the background.~~ Abandoned 2026-11-26: the maintainer does not care about the window; the
      principle "acknowledge first, then process" stays in the docs.

## 13. Respond to PR comments

Responding to review comments on the PRs the agent opens completes the PR-sending pattern: the
agent proposes a change, a human reviews it, and the agent revises it.

- [x] Design how a PR comment becomes a turn, who may trigger it, and loop prevention:
      [docs/pr-comments.md](docs/pr-comments.md), all recommendations accepted.
- [x] PR comments 1: poster operations `link-pull-request` and `resolve-pull-request` (state-table
      record keyed by repo and PR number, repo check, TTL), with tests and `docs/poster.md`.
- [x] PR comments 2: `finish` links the PR to its thread (chat turns and scheduled prompts).
- [x] PR comments 3: `resolve-pr-comment` action and `resolve` command (event parsing, filters,
      permission and marker checks, outputs). Also restore the design's flag on
      `resolve-pull-request` so the raw `threadId` is returned only when asked for.
- [x] PR comments 4: comment mode in `prepare`.
- [x] PR comments 5: comment mode in `finish` (reply with the marker, plain `git push`, chat note,
      refresh the record).
- [x] PR comments 6: wire the `turn` action with a `comment` input.
- [x] PR comments 7: `.github/workflows/centaur-pr-comment.yml` in this repo and the docs that say
      it exists.
- [x] PR comments 8: verify event coverage on a real PR (inline comment, batched review, inline
      reply, conversation comment, fork PR, bot comment) and settle
      `pull_request_review_comment`. Needs `centaur-pr-comment.yml` on `main`, the deployed poster
      (`withThreadId`) and a real `centaur/` PR with a linked thread (**[HUMAN ACTION]**).
      Verified on a real PR (run `centaur-hello` with `-f prompt_name=pr-smoke`): conversation
      comment, inline comment, batched review (conversation reply) and inline reply (threaded
      reply); each fires `pull_request_review` or `issue_comment` only, so
      `pull_request_review_comment` is not needed. A commenter without write access and a fork PR
      are skipped with the expected reasons. Bot senders are covered by unit tests only.
- [x] PR comments 9: reference consumer in `blevinstein/garden` and the end-to-end check, where a
      review comment on a `weekly-tasks` PR gets an in-thread reply and a pushed fix.

- [x] `centaur-pr-comment.yml` checks out the PR branch and then runs this repo's local actions from
      it, so a PR that edits `.github/actions/**` runs its own edit on the next comment. Run the
      actions from the default branch (or check the PR branch out into a subdirectory).
- [x] `resolve` treats any permission API error as "no write access"; warn on errors other than
      403 and 404 so outages are visible.
- [x] Consider filtering comment authors by `author_association` in comment-mode `prepare`, since it
      answers every human comment since the last marked one.

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
- [x] ~~Verify the `plan-pr` rejection and `push-existing` conflict fallbacks in a real run.~~
      Abandoned 2026-11-26: covered by unit tests and real-git tests.
- [x] Match `centaur/<bot>-` branches exactly in `checkCandidate` (a bot named `sprout` also
      matches `sprout-2`'s branches when no poster record exists).
- [x] Rank PR candidates by update time instead of number if busy repos show stale ones.
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
- [x] **[HUMAN ACTION]** Per bot, after the cutover as in the design doc: `centaur bot add <bot>
      --platform slack`, a Slack app event URL change, `centaur admin claim <bot> --platform slack`
      and a test message on each live bot. Adding a platform to a bot is `bot add --platform`,
      nothing else. Moot 2026-11-26: `centaur-slack`, `centaur-test-2` and the garden-style bots
      already have both platforms; the others are Telegram-only by choice.
- [x] **[HUMAN APPROVAL]** After a soak, unbind and remove the old Slack-only bot and its config.
      Moot 2026-11-26: no Slack-only bot remains.
- [x] Platforms 20: delete the one-time migration code once the cutover has soaked and every
      consumer config and bot is migrated. The migration tooling (slice 4) is a lot of code for a
      single use: remove `bot migrate` (copy, verify, `--prune`, `--alias-platform`,
      `--drop-alias`), `config migrate` with its line-splicing and the `diff` dependency, and
      `bot adopt` if nothing else uses it, plus their tests, fixtures and `docs/cli.md` entries;
      reword the legacy-key error in `src/config/schema.ts`, which points at `centaur config
      migrate`, to say the key was removed. Decide then whether `bot export` and `bot restore`
      stay as a general backup. Check the Lambda and CLI bundles and `yarn install --immutable`
      afterwards. **[HUMAN APPROVAL]** to start, since it deletes the way back for a rollback. Done 2026-11-23.
- [x] Live checks on the test bot (slice 19): moved to Backlog 2026-11-26.
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

- [x] Chat context tools: let the agent read other threads in its chat through a built-in MCP server
      backed by new poster operations. Decisions accepted 2026-11-27
      ([docs/chat-context.md](docs/chat-context.md)).
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
  - [x] Chat search 4: Slack-native search. Design in
        [docs/chat-search.md](docs/chat-search.md#slice-4-decisions); the design was approved
        2026-11-26 (nothing retrieved from Slack is stored beyond the short-lived token). Agent slices, in order (stop after 4.4 if its stop conditions hold):
    - [x] 4.1 Receiver captures the `action_token` into the state table (TTL, never logged). Merged
          as a7f0259.
    - [x] 4.2 Poster `search-chat` operation (caller check, public-channel and sender filters, clip,
          `unavailable` results, client method). Merged as a7f0259.
    - [x] **[HUMAN ACTION]** 4.3 Deploy 4.1 and 4.2; reinstall the Slack app so the token has
          `search:read.public`. Done 2026-11-27.
    - [x] **[HUMAN ACTION]** 4.4 Live check (2026-11-27): the token arrives only with the agent view
          enabled; search is workspace-wide (post-filter kept); `in:<#C...>` scopes it; a burst gets
          429 with `Retry-After: 60`; lifetime still being measured. Details in
          [chat-search.md](docs/chat-search.md#slice-4-live-results).
    - [x] 4.5 MCP `search_chat` tool, registered only with `chat_tools.slack_search` (built; the
          poster scopes the query with `in:<#ID>`).
    - [x] **[HUMAN ACTION]** 4.6 Enable `slack_search: true` on one bot and run the end-to-end
          check. Confirmed done by the maintainer 2026-11-27 (no results recorded here).
  - [x] Chat search 5: the stored-history window, tracked in the next item.
  - [x] **[HUMAN ACTION]** Chat search 6: verify the Telegram window cost on a real install (the
        Slack items moved to 4.4). Confirmed done by the maintainer 2026-11-27 (no results recorded
        here).
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
- [x] **[HUMAN APPROVAL]** Deploy the Lambda that knows the `skills` key (`yarn deploy-prod`) before
      any consumer's default branch sets `skills`; then check the `register` run. Consumers that do
      not set the key need no change.
      Done: deployed repeatedly since the skills commit (622aefe); deployed on every push to `main`
      since 2026-11-26 (section 23, in [DONE.md](DONE.md)).
- [x] Live check of the built-in skills on an `experiment/*` branch (2026-11-24): discovery,
      invocation, the consumer-skill name (`centaur-consumer-<folder name>`) and the comment-turn
      trust check (branch-committed skills are not visible) are done and recorded in
      [docs/skills-rules.md](docs/skills-rules.md#live-check-results).
- [x] **[HUMAN ACTION]** Live check, `Skill` in `--allowedTools` (2026-11-26): answered by the code
      and the run. `prepare` adds `Skill` whenever any skill is installed (`skillRule`,
      `src/workflows/prepare.ts`), and the live run's `claude_args` carried it and the skill
      invoked; there is no variant without it to test.
- [x] **[HUMAN ACTION]** Live check, resume (2026-11-26): moved to Backlog as an optional check.
      The failed run was a Slack thread where `/resume` never took effect (Slack rejects a message
      that starts with `/`, and Slack thread commands are not supported), so the thread ran at the
      default policy and passed no `--resume`; it says nothing about skill-body retention.
      (The trusted `CLAUDE.md` question under `--setting-sources user` is answered: it does not
      reach a comment turn on its own; see the harness instructions item in Needs triage.)

## 21. Poster caller check

Implemented: the poster verifies the caller's GitHub OIDC token on `post`, `unreact`,
`start-thread` and `get-mcp-policy` ([docs/poster.md](docs/poster.md#security-model)).

- [x] **[HUMAN APPROVAL]** Deploy the Lambda (`yarn deploy-prod`) with the caller check and the
      inspection role. Deploy before the runner change reaches consumers pinned to `main`: an older
      Lambda rejects the new `token` field.
      Done 2026-11-26: the caller check (d1b92af) and the inspection role (dca2d8e) were deployed by
      hand, then by the `Deploy` workflow.
- [x] **[HUMAN APPROVAL]** Set `RequirePosterToken=true` once the Lambda's "poster call without a
      token" warnings stop. Rollback: set it to `false` and redeploy.
      Done 2026-11-26: the flag is set in the deployed stack and a real turn replied; the Lambda
      logged 0 tokenless warnings in the 3 days before.

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
- [x] **[HUMAN ACTION]** Execution 3 real run (protected branch, ruleset bypass, protected-path
      fallback): moved to Backlog 2026-11-26 as an optional manual check.
- [x] ~~**[HUMAN ACTION]** Set `handle` for the `respond_to: all` test bot (`centaur-slack`)~~
      Not needed: the receiver sends the bot's own username and display name in the dispatch payload
      and the prompt's `# Who you are` section tells the agent both (the `handle` config key was
      removed). It had answered in the first person as the other test bot in a shared chat. Still to
      confirm live after deploy: the bot no longer speaks as the other bot.
- [x] Execution 4: prompt text and `replySchema` fields for the mode. Merged as 14f1b23.

## 23. Continuous deployment

Workflows `ci.yml` and `deploy.yml`, `DeployRole` in `infra/centaur.yml` and the setup are
described in [docs/deploy.md](docs/deploy.md#continuous-deployment). Decided 2026-11-26: the role
lives in the main stack, every push to `main` deploys through the `production` environment (no
required reviewer), and a dispatch redeploys a chosen ref.

- [x] **[HUMAN ACTION]** Before merging or pushing: `scripts/setup-cd.sh environment`. Unrestricted,
      the `production` environment lets any branch's workflow assume the role.
      Done 2026-11-26.
- [x] **[HUMAN APPROVAL]** Merge and push (the first `deploy` job fails harmlessly at credentials),
      then deploy by hand (`yarn deploy-prod`) from the merged commit, reviewing the change set
      (existing roles gain a permissions boundary) and smoke-testing both bots.
      Done 2026-11-26.
- [x] **[HUMAN ACTION]** `scripts/setup-cd.sh credentials` (sets `DEPLOY_ROLE_ARN` and
      `DEPLOY_PARAMETERS`; `CENTAUR_AWS_REGION` must already exist).
      Done 2026-11-26.
- [x] **[HUMAN APPROVAL]** The first real run failed to assume the role: the repository uses
      immutable OIDC subjects (`repo:<owner>@<ownerId>/centaur@<repoId>:environment:production`)
      and the trust lacked the repository id. The template now matches it. The deploy role cannot
      edit its own trust, so deploy by hand (`yarn deploy-prod`), then re-run the `Deploy`
      workflow.
      Done 2026-11-26: trust fixed in aed536c and deployed by hand.
- [x] **[HUMAN APPROVAL]** Run the `Deploy` workflow to confirm it assumes the role. If it fails to
      assume it, compare the token's `sub` with the trust (`scripts/setup-cd.sh check` prints the
      repository's `sub_claim_prefix`).
      Done 2026-11-26: the `Deploy` workflow succeeded for aed536c and de3ddac.
- [x] **[HUMAN APPROVAL]** Decide on branch protection for `main` and required reviewers on
      `production`: moved to Backlog 2026-11-26.

## Quality Improvements

- [x] Bots across platforms and topic destinations: one bot with several platform connections, and
      named destinations that point at a topic or thread. Design, alternatives and the Decisions:
      [docs/platforms-and-destinations.md](docs/platforms-and-destinations.md); implementation is
      tracked in section 16.
