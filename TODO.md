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

- [ ] Add `.centaur.yml`, `.centaur/persona.md`, and `.centaur/prompts/weekly-tasks.md`.
- [ ] Add the caller workflow with the Saturday schedule.
- [ ] Update `garden`'s `AGENTS.md` so automated runs open PRs instead of pushing to `main`.

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

## Later

- [ ] Poster MCP tool for mid-turn questions and progress messages.
- [ ] Two bots in one group: with a second bot from BotFather, confirm the ownership rules route
      messages correctly (needs the maintainer to create the bot; see `HUMAN_TODO.md` then).
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [ ] Contribute the DynamoDB state adapter upstream, if we write one.
