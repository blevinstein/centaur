# Human TODO

Tasks that only the maintainer can do: they need accounts, credentials, a phone, a live bot, or a
decision. Agents can't take these, so they live here and not in [TODO.md](TODO.md). Check items
off as you finish them; agents read this file to see what is unblocked.

Agents: when work stalls on something only the maintainer can do, add it here with what it
unblocks, and remove it from `TODO.md`.

## 1. Deploy the stack

Unblocks: everything below.

- [x] Copy `parameters.example.json` to `parameters-prod.json` and fill in the values (see
      [docs/deploy.md](docs/deploy.md) for where to find each). The file is gitignored.
- [x] Check whether the account already has a GitHub OIDC provider (an account can have only one).
      If so, set `ExistingOidcProviderArn` in `parameters-prod.json` to its ARN.
- [x] Run `npm run deploy-prod`. It deploys the stack in two passes (bucket first, then the
      Lambda) and prints the outputs: function name, function URL, role ARN and session bucket.
- [x] If the function fails on cold start, check its CloudWatch logs and report what you see.

## 2. Create the test bot and its secrets

- [x] In BotFather, run `/newbot` for a test bot.
- [x] `centaur bot add <bot> --platform telegram` with the bot token.
- [x] Create a fine-grained GitHub PAT limited to the test repo with Contents: write, and store
      it with `centaur github-token set`.
- [x] Create a test supergroup with Topics enabled and add the bot as admin with Manage Topics.
- [x] Admit yourself and the group: run `centaur admin claim <bot>` (open the link, tap
      **Start**, which makes you the admin and so allowed in every bot), then mention the bot in
      the group and approve the chat from the bot's DM; or by hand with `centaur access approve
      <bot> chat <chat id> --name <title>` (the receiver logs unknown chat IDs). Each other
      person needs a user approval too.

## 3. Wire a test consumer repo

Use a scratch repo first; `garden` comes after this works.

- [x] Add `.centaur.yml`, `.centaur/persona.md` and a prompt under `.centaur/prompts/`, plus the
      caller workflow from [docs/workflows.md](docs/workflows.md). Agents can write these files
      when you point them at the repo.
- [x] Set the repo variables `CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`, `CENTAUR_FUNCTION_NAME`,
      `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`, and the `ANTHROPIC_API_KEY` secret.
- [x] Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings.
- [x] If the shared repo is private, allow the consumer repo to call its workflows.
- [x] Push, then check `bots/<bot>/repo` appears in SSM (the `register` job worked).

## 4. End-to-end validation on Telegram

- [x] Message the bot in a topic: message → dispatch → turn → reply. Measured on the test group:
      about 47 s from dispatch to posted reply (queue 4 s, runtime setup 7 s, agent 27 s, post 3 s).
      The receiver's own response took under a second per request.
- [x] Run the scheduled prompt with `workflow_dispatch`; it opened a new topic (checked in the state
      table: thread marked `createdByBot`, the bot's post in the topic's history).
- [x] Reply in that topic (no mention needed). Verified: the run succeeded, the topic's transcript
      holds the bot's post, your reply and the bot's answer in order, and the last-processed marker
      for the topic advanced.
- [x] Repeat the `Chat`-against-DynamoDB run on the deployed table. Items checked: per-bot key
      prefixes, TTLs on dedupe, webhook-update and history entries, unprefixed `registry:<bot>`,
      and `thread-state` for the bot-created topic.
- [ ] Walk through [docs/onboarding.md](docs/onboarding.md) as written and report anything wrong.
- [ ] Report anything from the "Still unverified" list in `docs/onboarding.md` that breaks.
      Worked in the test repo: `execution_file` output shape, `repository_dispatch` with
      `claude-code-action`, and `vars` (the caller and called workflow share a repo here, so this
      doesn't prove the cross-repo case). Not exercised yet: the `job.workflow_*` contexts (this
      repo passes the inputs explicitly) and a consumer in a different repo.

## 5. First consumer: `garden`

Unblocked by section 4.

- [x] Point an agent at `garden` to add the config, persona, prompt, caller workflow and
      `AGENTS.md` change (these are in [TODO.md](TODO.md) section 8).
- [ ] Onboard the household group: claim the admin role (`centaur admin claim <bot>`, open the
      link), mention the bot in the group, then approve the group and each user from the bot's DM
      instead of by hand.

## 6. Slack

- [ ] Decide one app per repo vs one shared app with per-message names.
- [ ] Onboard one personal-project repo on Slack (create the app from the manifest once it exists,
      install it, store its secrets, invite the bot).
- [ ] Measure the Slack webhook acknowledgement time; Slack expects a 200 within about 3 seconds.

## Decisions waiting on you

- [ ] **Transcript size bound.** The poster returns up to 100 stored messages and a long thread or
      one huge message goes into the prompt unmodified. Choose a bound (per-message cap, total
      budget, summarising) and where it lives.
- [ ] **Poster caller check and concurrency cap.** Poster operations other than `register`
      trust any role the GitHub OIDC role allows, so any repo under the owner could act as any bot.
      Decide when to require a per-repo token (before onboarding any repo that isn't yours) and
      add a reserved-concurrency cap on the function.
- [ ] **`job.workflow_*` contexts.** `actionlint` doesn't know `job.workflow_repository` or
      `job.workflow_sha`, which the shared workflows use. Decide whether to require the
      `centaur_repository` and `centaur_ref` inputs instead.
- [ ] **Thread policy storage.** A scheduled prompt's context policy isn't remembered for the
      thread. Decide whether the poster should store it.
- [x] **`garden` is public and centaur was private.** Centaur is now public, so `garden` can call
      its workflows. A public consumer still puts workflow logs and PR branch names in public view;
      the thread-ID hashing in `TODO.md` is needed before `garden` goes live.
- [ ] **`ANTHROPIC_API_KEY` for `garden`.** Secret values can't be copied between repos by an
      agent. Run `gh secret set ANTHROPIC_API_KEY -R <owner>/garden` and paste the key.
- [ ] **A second bot for `garden`.** Create it in BotFather and run `centaur bot add garden
      --platform telegram`; also create the household group and enroll the household member.
- [ ] **License.** The repo is public and has no `LICENSE` file. Choose one and add it (an agent can
      write the file once you pick).
- [ ] **Garden PR #7.** The first `weekly-tasks` run opened it with the old generic title. Merge or
      close it, then re-run `weekly-tasks` to check the agent-written title and body.
