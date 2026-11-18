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
- [ ] Send one message in the group, and before the webhook is set (section 3) read the chat and
      your user ID from Telegram's pending updates:
      `TOKEN=$(aws ssm get-parameter --name /centaur/bots/<bot>/token --with-decryption --query Parameter.Value --output text)`
      then `curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | jq '.result[].message | {chat: .chat.id, from: .from.id}'`.
      Once a webhook is set, `getUpdates` stops working and the receiver logs unknown chat IDs
      instead.
- [ ] `centaur chat add <name> <chat id>` and `centaur user add <you> --telegram <your id>`.

## 3. Wire a test consumer repo

Use a scratch repo first; `garden` comes after this works.

- [ ] Add `.centaur.yml`, `.centaur/persona.md` and a prompt under `.centaur/prompts/`, plus the
      caller workflow from [docs/workflows.md](docs/workflows.md). Agents can write these files
      when you point them at the repo.
- [ ] Set the repo variables `CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`, `CENTAUR_FUNCTION_NAME`,
      `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`, and the `ANTHROPIC_API_KEY` secret.
- [ ] Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings.
- [ ] If the shared repo is private, allow the consumer repo to call its workflows.
- [ ] Push, then check `bots/<bot>/repo` appears in SSM (the `register` job worked).

## 4. End-to-end validation on Telegram

- [ ] Message the bot in a topic: message → dispatch → turn → reply. Note the latency.
- [ ] Run the scheduled prompt with `workflow_dispatch`; confirm it opens a new topic, then reply
      and confirm the transcript carries over.
- [ ] Add a second bot to the same group and confirm the ownership rules route messages correctly.
- [ ] Repeat the `Chat`-against-DynamoDB run on the deployed table (a real message through the
      deployed receiver is enough; check the table items afterwards).
- [ ] Walk through [docs/onboarding.md](docs/onboarding.md) as written and report anything wrong.
- [ ] Report anything from the "verify on first live run" list in `docs/workflows.md` that breaks
      (the `job.workflow_*` contexts, `execution_file` output shape, `repository_dispatch` with
      `claude-code-action`, `--append-system-prompt-file`, `vars` in reusable workflows).

## 5. First consumer: `garden`

Unblocked by section 4.

- [ ] Point an agent at `garden` to add the config, persona, prompt, caller workflow and
      `AGENTS.md` change (these are in [TODO.md](TODO.md) section 8).
- [ ] Onboard the household group and enroll both users.

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
