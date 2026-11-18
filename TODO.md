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
- [x] Write a DynamoDB `StateAdapter` for the Chat SDK (19 methods, see `docs/research.md`) with
      tests, starting from `state-memory`'s test suite.
- [x] Run `Chat` end to end against the DynamoDB adapter on DynamoDB Local, checking how the
      core uses the `appendToList` TTL, `maxLength`, and expired queue entries.
- [x] Add the state table (mirroring `stateTableInput`: pay-per-request, TTL on `ttl`) and its
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
- [ ] **[HUMAN APPROVAL]** Choose a license; the public repo has no `LICENSE` file. An agent can
      write the file once you pick.

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
- [ ] Bound the transcript size rendered into the prompt (per-message cap, total budget). Consider using polytokenizer utils for this (github.com:blevinstein/polytokenizer)
- [x] Switch the package manager from npm to yarn or pnpm (pick one; the maintainer's other
      projects use yarn). Replace `package-lock.json` and update everything that calls npm:
      `AGENTS.md`, `scripts/deploy.sh`, `.github/workflows/*.yml` and the setup-runtime composite
      action (`npm ci && npm run build`), `.nvmrc`/Corepack pinning, the docs that say `npm run`,
      and the `bin` and `deploy-prod` scripts. Verify lint, typecheck, tests, the Lambda bundle and
      `actionlint` still pass.
- [ ] **[HUMAN APPROVAL]** Roll out `thread_key` in this order, since a workflow that uses it
      against a receiver that doesn't send it yet puts all of a bot's threads in one concurrency
      group and drops pending turns: (1) deploy the receiver (`yarn deploy-prod`), (2) update
      `garden`'s `.github/workflows/centaur-message.yml` to use `thread_key` in its concurrency
      group, (3) merge or close open `centaur/<bot>-<raw thread id>` PRs, and (4) confirm on a real
      run that the raw `thread_id` doesn't show in the Actions UI or logs.
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

## 10. Decisions

- [ ] **[HUMAN APPROVAL]** Transcript size bound. The poster returns up to 100 stored messages and a
      long thread or one huge message goes into the prompt unmodified. Choose a bound (per-message
      cap, total budget, summarising) and where it lives; see also the transcript item in section 9.
- [ ] **[HUMAN APPROVAL]** Poster caller check and concurrency cap. Poster operations other than
      `register` trust any role the GitHub OIDC role allows, so any repo under the owner could act
      as any bot. Decide when to require a per-repo token (before onboarding any repo that isn't
      yours) and add a reserved-concurrency cap on the function.
- [ ] **[HUMAN APPROVAL]** Thread policy storage. A scheduled prompt's context policy isn't
      remembered for the thread. Decide whether the poster should store it.

## 11. MCP support

- [ ] Poster MCP tool for mid-turn questions and progress messages.
- [ ] Additional MCP servers configurable in `.centaur.yml`: a schema section listing servers
      (name, command and args, or URL, plus env), written into the turn's MCP config for
      `claude-code-action`, with secrets referenced by name from repo secrets and never inline.
      Decide how `allowed_tools` names them (`mcp__<server>__*`) and how a consumer repo trusts
      the servers it lists.

## 12. Slack support

- [ ] App manifest template with the required scopes and event URL.
- [ ] **[HUMAN APPROVAL]** Decide one Slack app per repo vs one shared app with per-message names.
- [ ] **[HUMAN ACTION]** Onboard one personal-project repo on Slack: create the app from the
      manifest once it exists, install it, store its secrets, invite the bot.
- [ ] **[HUMAN ACTION]** Measure the Slack webhook acknowledgement time; Slack expects a 200 within
      about 3 seconds.
- [ ] If the 3-second limit is missed, acknowledge first and finish the reaction and dispatch in
      the background.

## 13. Respond to PR comments

Responding to review comments on the PRs the agent opens completes the PR-sending pattern: the
agent proposes a change, a human reviews it, and the agent revises it.

- [ ] Design how a PR comment becomes a turn: which GitHub events trigger it (`issue_comment`,
      `pull_request_review`, `pull_request_review_comment`), how a PR maps to the chat thread
      that opened it (the `centaur/<bot>-<thread>` branch), which context policy applies, and how
      the agent's reply and any follow-up commits reach the PR. Record it in `docs/`.
- [ ] Decide who may trigger a turn from a comment (the repo's collaborators, the bot's admin
      approvals, or both) and how bot-authored comments are ignored so turns can't loop.
- [ ] Expand the centaur example (caller workflow, config and docs) to include responding to PR
      comments.
- [ ] Add the same to the reference implementation in `blevinstein/garden`, and check that a review
      comment on a `weekly-tasks` PR gets an in-thread reply and a pushed fix.

## Backlog

Every item here is **[HUMAN APPROVAL]**: do not start one without the maintainer saying so.

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
- [ ] Contribute the DynamoDB state adapter upstream, if we write one.
