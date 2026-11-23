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

## Quality Improvements

- [x] Bots across platforms and topic destinations: one bot with several platform connections, and
      named destinations that point at a topic or thread. Design, alternatives and the Decisions:
      [docs/platforms-and-destinations.md](docs/platforms-and-destinations.md); implementation is
      tracked in section 16.
