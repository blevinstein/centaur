# Onboarding

Setup flows by role: the maintainer (once for the stack, once per bot and repo) and household
members (almost nothing). The Telegram flow and a consumer in this repo were validated in a live
run; steps marked **validate** are still untested.

## Maintainer: deploy the stack (once)

1. `npm ci`.
2. Copy `parameters.example.json` to `parameters-prod.json` and fill it in (see
   [deploy.md](deploy.md#parameters-file)). An account can have only one GitHub OIDC provider:
   run `aws iam list-open-id-connect-providers` and, if `token.actions.githubusercontent.com` is
   listed, set `ExistingOidcProviderArn` to its ARN.
3. `npm run deploy-prod`. It prints the function name, function URL, role ARN and session bucket;
   you need them for the repo variables below.
4. Install the [CLI](cli.md#install-and-run) (`npm run build && npm link`) and set `AWS_PROFILE`
   and `AWS_REGION` for the stack's account.
5. Create a fine-grained GitHub PAT limited to the consumer repos with Contents: write, and store
   it: `CENTAUR_BOT_GITHUB_TOKEN=<token> centaur github-token set`. The receiver uses it to
   dispatch workflows.

## Telegram (household repos)

### Key constraint

Telegram bots can't start conversations: "A user must either add them to a group or send them a
message first." That shapes the flow:

- **Group conversations need no per-user setup.** Once the maintainer adds a bot to the household
  group, it can post there, including scheduled outreach, and everyone in the group sees it.
- **DMs need one tap per person per bot.** Each person opens the bot and taps **Start** once.
  Until they do, the bot can't DM them. DMs are optional; the group is the main channel.

### Maintainer: once per bot and group

The order matters: read the chat and user IDs **before** the webhook is set. Once the bot's
webhook exists, `getUpdates` stops working, and the only way to find an unknown ID is the
receiver's logs.

1. In Telegram, message [@BotFather](https://t.me/BotFather): `/newbot`, choose a display name
   (e.g. "Garden Helper") and a username ending in `bot`. Optionally set the profile so it's
   recognizable: `/setuserpic`, `/setdescription`, `/setabouttext`.
2. Store the token: `centaur bot add garden --platform telegram`. It prompts for the token and
   generates the webhook secret.
3. Create the group (e.g. "Household") with the other participant, enable **Topics** in the group
   settings (this converts it to a supergroup), add each bot, and promote it to **admin** with
   the **Manage Topics** right. Admin bots receive all group messages, and topic creation
   requires that right.
4. Send one message in the group, then read the IDs from the pending updates:

   ```sh
   TOKEN=$(aws ssm get-parameter --name /centaur/bots/garden/token --with-decryption \
     --query Parameter.Value --output text)
   curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" \
     | jq '.result[].message | {chat: .chat.id, from: .from.id}'
   ```

   The group's chat ID is negative (a supergroup is `-100...`); don't use a DM's positive ID.
   Each person who should be able to talk to the bot sends one message so you can read their
   `from` ID.
5. `centaur chat add household <group chat id>` and `centaur user add <name> --telegram <id>` for
   each person. IDs are stored by person and referenced by name in `.centaur.yml`'s `allow`
   list, so each person is enrolled once, not once per bot.
6. [Add the repo](#adding-a-repo). Its first registration sets the webhook.

If someone is missing from the allowlist, the bot replies "Sorry, you aren't enrolled to talk to
me." and logs their user ID (a bot with `respond_to: all` ignores unenrolled people in the group
silently, but still logs the ID). Add them with `centaur user add` and the repo's `allow` list.

### Household member (non-technical): once

1. Install Telegram and sign up with a phone number.
2. Tap the group invite link the maintainer sends.

That's all that's needed for group use. Optionally, to DM a bot: open its link
(`t.me/<bot_username>`) and tap **Start**.

### Day-to-day use

- **Scheduled outreach** shows up as a new topic, e.g. "Garden tasks: week of Nov 23". Reply in
  the topic to continue that conversation; no mention is needed.
- **Start a conversation:** by default a bot answers mentions, DMs, and messages in topics it
  created. Mention it in the General topic, e.g. `@garden_helper_bot the tomatoes have yellow
  leaves`; it replies there for quick questions or opens a topic for longer ones.
- **Answering everything:** a bot with `respond_to: all` (and `handle` set to its username)
  treats every message from an allowed sender in its group as possibly for it, and the agent may
  stay silent. Use it in small private groups with at most one such bot
  ([config](config.md#responding-to-all-messages)).
- **Progress:** a 👀 reaction appears on your message while the turn runs and is removed when it
  is done (also after a failure, when the bot posts a notice and retries the message on the next
  turn).
- **Commands**, at the start of a message: `/new` opens a new topic without the old context;
  `/resume` and `/transcript` switch how the thread's context is rebuilt
  ([policies](workflows.md#context-policies)).
- **Results:** when the agent changes a repo, its reply links the pull request. The maintainer
  reviews and merges it; household members don't need to do anything.

## Adding a repo

Repeat for each consumer repo, after the bot exists (Telegram above, Slack below).

1. In the repo, add:
   - `.centaur.yml` ([schema](config.md): bot, platform, `chats`, `allow`, `respond_to`,
     `handle`, context, model and cost-tuning fields, tool allowlist, persona);
   - `.centaur/persona.md`, and any scheduled prompts under `.centaur/prompts/`;
   - the caller workflow in `.github/workflows/`, copied from
     [workflows.md](workflows.md#caller-workflow).
2. In the repo's Settings > Secrets and variables > Actions:
   - **Variables** (not secrets): `CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`,
     `CENTAUR_FUNCTION_NAME`, `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`; values are in
     [workflows.md](workflows.md#variables-and-secrets).
   - **Secret** for the bot's `provider` (`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`), plus
     anything the agent's tools need.
3. Settings > Actions > General: enable "Allow GitHub Actions to create and approve pull
   requests".
4. If the centaur repo is private, open its Settings > Actions > General > Access and allow
   repositories under the owner to call its workflows.
5. If the consumer is in a different repo than centaur, pass `centaur_repository` and
   `centaur_ref` in `with:` on every reusable workflow call rather than relying on the
   `job.workflow_*` contexts, which are unverified across repos (**validate**). The
   [caller example](workflows.md#caller-workflow) omits them.
6. Register the bot: push a change to `.centaur.yml` on the default branch, or run the workflow
   manually so the `register` job runs. Check that `bots/<bot>/repo` now exists in SSM.
7. Run the scheduled prompt once with a manual dispatch to confirm a test topic appears, then
   message the bot.
8. If the repo is public, check that its workflow follows the no-content-in-logs rules in
   [plan.md](plan.md#security).

## Slack (personal projects)

Only the maintainer uses these, so there's no non-technical onboarding. Nothing here is validated.

1. **Validate** Create the app from an app manifest, which predefines scopes and the event
   subscription URL `<function URL>/slack/<bot>`. No manifest exists in this repo yet. Whether
   one app per repo or one shared app posting under per-repo names is preferable is an open
   question ([plan.md](plan.md#open-questions)).
2. Install the app to the workspace; store the bot token and signing secret with `centaur bot add
   <bot> --platform slack`.
3. Set `platform: slack` in the repo's `.centaur.yml`, push to register, and invite the bot to its
   channel.
4. Enroll your Slack user ID: `centaur user add <name> --slack <id>`.

## Still unverified

- A second bot in the same group (routing between bots, Topics at this group size).
- A consumer repo different from the centaur repo (`job.workflow_*` contexts, repo access).
- Slack end to end, including acknowledging webhooks within Slack's 3 seconds.

Validated in the first live run: deploy, a Telegram bot with a Topics group, registration,
message-to-reply turns, scheduled topics, `respond_to: all`, and the 👀 reaction.
