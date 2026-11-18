# TODO

Tasks agents can do, in priority order, following the validation plan in [docs/plan.md](docs/plan.md#validation-plan).
Earlier sections retire the most risk; finish them before building on their results. Check items
off as they land, and record findings that change the design back into `docs/`.

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

- [x] State backend: a DynamoDB `StateAdapter` (plan open question 1).
- [x] Where turns execute for public consumer repos: in each repo's own Actions (plan open
      question 2).
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
- [x] Sender and chat allowlists; reply to unknown senders with a refusal and log their IDs.
- [x] Message ownership rules for a shared Telegram group (bot-created topics, mentions,
      ignore the rest).
- [x] On an accepted message: 👀 reaction, then a `repository_dispatch` carrying IDs only.
- [x] Poster operations, invoked over IAM: post a reply, start a new thread or topic, read a
      thread transcript.
- [x] `register` operation: take the repo name from the OIDC claims, require existing bot
      secrets, refuse to rebind a bot owned by another repo, and call `setWebhook` for Telegram.

## 5. CLI

- [x] `centaur bot add|remove <bot> --platform <platform>`: store the token and generate the
      webhook secret in SSM.
- [x] `centaur user add <name> --<platform> <id>` and `centaur chat add <name> <id>`.
- [x] `centaur bot unbind <bot>` to release a bot from its repo.

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

Human-only; see [HUMAN_TODO.md](HUMAN_TODO.md).

## 8. First consumer: `garden`

- [x] Add `.centaur.yml`, `.centaur/persona.md`, and `.centaur/prompts/weekly-tasks.md`.
- [x] Add the caller workflow with the Saturday schedule.
- [x] Update `garden`'s `AGENTS.md` so automated runs open PRs instead of pushing to `main`.

## 9. Slack

- [ ] App manifest template with the required scopes and event URL.
- [ ] If Slack's 3-second acknowledgement limit is missed (see [HUMAN_TODO.md](HUMAN_TODO.md)),
      acknowledge first and finish the reaction and dispatch in the background.

## Follow-ups

- [ ] Close the first-registration race on `bots/<bot>/repo` with a conditional `PutParameter`.
- [ ] Add a routing test for `src/lambda/handler.ts`.
- [ ] Cache SSM reads in the receiver; each accepted message makes 1 to 3 SSM calls.
- [ ] CLI: warn when `user add` and `chat add` overwrite an existing value; clearer error when piped
      stdin has too few lines.
- [ ] Decide whether `allow` and `destination` aliases are checked against SSM at register time.
- [ ] Optional `centaur config check` command wrapping `parseCentaurConfig`.
- [ ] Bound the transcript size rendered into the prompt (per-message cap, total budget).

- [ ] Switch the package manager from npm to yarn or pnpm (pick one; the maintainer's other
      projects use yarn). Replace `package-lock.json` and update everything that calls npm:
      `AGENTS.md`, `scripts/deploy.sh`, `.github/workflows/*.yml` and the setup-runtime composite
      action (`npm ci && npm run build`), `.nvmrc`/Corepack pinning, the docs that say `npm run`,
      and the `bin` and `deploy-prod` scripts. Verify lint, typecheck, tests, the Lambda bundle and
      `actionlint` still pass.

- [ ] Stop exposing thread IDs (Telegram chat and topic IDs) in the per-thread concurrency group
      name and the `centaur/<bot>-<thread>` PR branch name; use a short hash. Needed before any
      public consumer repo such as `garden`.

- [ ] Admin claim flow so the owner never looks up their own ID: `centaur admin claim <bot>`
      stores a short-lived claim code (hash, TTL) in SSM and prints a Telegram deep link
      (`t.me/<bot_username>?start=<code>`; Slack: a code to DM the bot). Whoever sends the code
      to the bot first becomes the admin (`/centaur/admin/<platform>`), which also opens the DM so
      the bot can reach them. The admin is implicitly allowed in every bot. Then drop the
      `getUpdates` ID-hunting steps from `docs/onboarding.md` and `HUMAN_TODO.md`; chats and users
      are discovered through access requests.

- [ ] Access requests record the chat title as `(unknown)` for an approved Telegram group; check
      whether the title is available on the request (and shown in the admin DM) and store it.
- [ ] Remove the allowlists from `.centaur.yml`; access is only the admin's approvals.
      Drop `allow` and `chats` (strict schema errors pointing at `centaur access` and the admin
      flow); access = admin (implicit) + per-bot approved chats/users in SSM, blocked wins;
      `respond_to: all` applies to every approved chat of the bot. A prompt's `destination` stays
      a required chat alias that must resolve to a chat approved for the bot, so approvals create
      the alias (from the chat title, numeric suffix on collision; shown in the admin DM;
      `--alias` on `centaur access approve`). Remove user aliases (`centaur user add|list`,
      `/centaur/users/*`, the IAM read) and keep `centaur chat add|list` for aliases only.
      Update registry entries (`register` stops writing `allow`/`chats`; stored legacy entries
      still read), the receiver, docs and the two consumer configs, and re-register.

- [ ] Rewrite `README.md` for public consumption; it is badly out of date (still says design
      phase). Cover: what centaur is and the architecture in one picture, a short demo of a chat
      exchange and the PR it produces, how a repo adopts it (the three files `.centaur.yml`,
      persona and prompts, the caller workflow, the repo variables and secret), a quick start for
      the maintainer (deploy, bot, admin claim, register), the safety model (admin approval, no
      content in GitHub logs, cost caps), and links into `docs/`.
- [ ] Draft a logo: a centaur crossed with a cat (nodding to the GitHub Octocat). Produce a few
      SVG concepts and a README header; the maintainer picks one. Don't reuse GitHub's Octocat
      artwork directly: its usage guidelines restrict modification, so make an original
      centaur-cat hybrid.

## Later

- [ ] Poster MCP tool for mid-turn questions and progress messages.
- [ ] Decision model: a cheap model that decides whether to reply to unaddressed messages in
      `respond_to: all` chats before the main agent runs (see
      https://docs.venice.ai/guides/features/decisions for the pattern). Preferably in the receiver,
      before dispatch, so a skipped message costs no workflow run; it needs a model key in SSM and
      a yes/no call that fits the webhook time budget. Leave it in the backlog; cheap models for
      the main agent are enough for now.
- [ ] Test how a turn behaves when `--max-budget-usd` stops a run before a structured reply.
- [ ] Two bots in one group: with a second bot from BotFather, confirm the ownership rules route
      messages correctly (needs the maintainer to create the bot; see `HUMAN_TODO.md` then).
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [ ] Contribute the DynamoDB state adapter upstream, if we write one.
