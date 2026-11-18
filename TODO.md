# TODO

Tasks in priority order, following the validation plan in [docs/plan.md](docs/plan.md#validation-plan).
Earlier sections retire the most risk; finish them before building on their results. Check items
off as they land, and record findings that change the design back into `docs/`.

## 1. Validate the agent runtime

- [ ] Create a private scratch repo with a `workflow_dispatch` workflow that runs
      `anthropics/claude-code-action@v1` with a trivial prompt via the Anthropic API.
- [ ] Run the same workflow through OpenRouter using its documented Action setup
      (`anthropic_api_key` plus `ANTHROPIC_BASE_URL`). If auth fails, try
      `ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer <key>"`. Record which works in
      `docs/research.md`.
- [ ] Confirm `--json-schema` in `claude_args` produces a usable `structured_output` with a
      required `reply` field.
- [ ] Capture `session_id`, find the session `.jsonl` under `~/.claude/projects/`, and confirm
      the escaped-cwd directory name is stable across runs.
- [ ] Upload the session file to S3 using a GitHub OIDC role (no stored AWS keys), restore it in
      a second run, and confirm `--resume <session_id>` continues the conversation.
- [ ] Note typical per-turn latency and token cost.

## 2. Decide open design questions

- [ ] State backend: write a DynamoDB `StateAdapter`, or use hosted Redis or Postgres with an
      existing adapter (plan open question 1). Check the `StateAdapter` interface in
      `vercel/chat` `packages/chat/src/types.ts` and the existing adapters' tests to size the
      DynamoDB option.
- [ ] Where turns execute for public consumer repos (plan open question 2).
- [ ] GitHub credential for dispatch: GitHub App vs fine-grained PAT.

## 3. Infrastructure

- [ ] Choose the language and tooling for the Lambda and CLI (TypeScript, to match Chat SDK) and
      set up the package with lint, typecheck, and tests.
- [ ] CloudFormation template: receiver/poster Lambda with a function URL, state backend, S3
      session bucket, SSM parameter paths, and the GitHub OIDC provider and role. The role's
      trust is limited by a `GitHubOwner` parameter. The template imports nothing.
- [ ] Deploy script that takes parameter overrides from the caller, so personal values stay in
      the deployer's private infra repo.

## 4. Receiver and poster

- [ ] Convert Lambda function URL events to and from web `Request`/`Response` for Chat SDK
      webhook handlers.
- [ ] Build the `Chat` instance from the registry and SSM secrets at cold start, with
      per-bot webhook paths (`/telegram/<bot>`, `/slack/<bot>`).
- [ ] Sender and chat allowlists; reply to unknown senders with a refusal and log their IDs.
- [ ] Message ownership rules for a shared Telegram group (bot-created topics, mentions,
      ignore the rest).
- [ ] On an accepted message: 👀 reaction, then a `repository_dispatch` carrying IDs only.
- [ ] Poster operations, invoked over IAM: post a reply, start a new thread or topic, read a
      thread transcript.
- [ ] `register` operation: take the repo name from the OIDC claims, require existing bot
      secrets, refuse to rebind a bot owned by another repo, and call `setWebhook` for Telegram.

## 5. CLI

- [ ] `centaur bot add|remove <bot> --platform <platform>`: store the token and generate the
      webhook secret in SSM.
- [ ] `centaur user add <name> --<platform> <id>` and `centaur chat add <name> <id>`.
- [ ] `centaur bot unbind <bot>` to release a bot from its repo.

## 6. Shared workflows

- [ ] `register.yml` (`workflow_call`): parse `.centaur.yml` and invoke `register`.
- [ ] `agent-turn.yml` (`workflow_call`):
  - [ ] Read `.centaur.yml` and the thread's context policy.
  - [ ] Assemble context for `fresh`, `transcript`, and `resume`.
  - [ ] Process all messages since the thread's last-processed marker.
  - [ ] Run the agent, post the reply via the poster, open a PR when files changed.
  - [ ] Per-thread `concurrency` group.
  - [ ] Keep message content out of logs and artifacts.
- [ ] In-chat commands: `/new`, `/resume`, `/transcript`.
- [ ] Define and validate the `.centaur.yml` schema.

## 7. End-to-end on Telegram

- [ ] Create a test bot and a test supergroup with topics; promote the bot to admin with
      Manage Topics.
- [ ] Message → dispatch → turn → reply round trip; measure latency.
- [ ] Two bots in one group: confirm the ownership rules route messages correctly.
- [ ] Scheduled run creates a new topic; a reply continues it under `transcript`.
- [ ] Walk through `docs/onboarding.md` as written and fix anything that's wrong.

## 8. First consumer: `garden`

- [ ] Add `.centaur.yml`, `.centaur/persona.md`, and `.centaur/prompts/weekly-tasks.md`.
- [ ] Add the caller workflow with the Saturday schedule.
- [ ] Update `garden`'s `AGENTS.md` so automated runs open PRs instead of pushing to `main`.
- [ ] Onboard the household group and enroll both users.

## 9. Slack

- [ ] App manifest template with the required scopes and event URL.
- [ ] Decide one app per repo vs one shared app with per-message names.
- [ ] Onboard one personal-project repo on Slack.

## Later

- [ ] Poster MCP tool for mid-turn questions and progress messages.
- [ ] Agent-scheduled follow-ups via EventBridge Scheduler.
- [ ] Per-thread turn or token caps for `resume` sessions.
- [ ] Contribute the DynamoDB state adapter upstream, if we write one.
