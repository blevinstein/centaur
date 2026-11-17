# Onboarding

Anticipated setup flows. Steps marked **validate** depend on behavior not yet tested.

## Telegram (household repos)

### Key constraint

Telegram bots can't start conversations: "A user must either add them to a group or send them a
message first." That shapes the flow:

- **Group conversations need no per-user setup.** Once the maintainer adds a bot to the household
  group, it can post there, including scheduled outreach, and everyone in the group sees it.
- **DMs need one tap per person per bot.** Each person opens the bot and taps **Start** once.
  Until they do, the bot can't DM them. DMs are optional; the group is the main channel.

### Maintainer: once per bot

1. In Telegram, message [@BotFather](https://t.me/BotFather): `/newbot`, choose a display name
   (e.g. "Garden Helper") and a username ending in `bot`.
2. Set the profile so it's recognizable in the group: `/setuserpic`, `/setdescription`,
   `/setabouttext`.
3. Store the token in SSM with the CLI in this repo (e.g. `centaur bot add garden --platform
   telegram`). It prompts for the token and generates the webhook secret.
4. Push the consumer repo's `.centaur.yml` (see [Adding a repo](#adding-a-repo)). Its `register`
   job binds the bot to the repo and calls `setWebhook` with `url=<function URL>/telegram/<bot>`
   and the generated secret. No redeploy is needed.

### Maintainer: once for the household group

1. Create a group (e.g. "Household") with the other participant.
2. Enable **Topics** in the group settings. This converts it to a supergroup. **Validate** that
   topics can be enabled at this group size.
3. Add each bot to the group and promote it to **admin** with the **Manage Topics** right. Admin
   bots receive all group messages, and topic creation requires that right.
4. Record the group's chat ID as the `household` destination (`centaur chat add household
   <id>`). The receiver logs chat IDs for unknown chats, so sending one message after adding the
   bot is enough to find it.

### Household member (non-technical): once

1. Install Telegram and sign up with a phone number.
2. Tap the group invite link the maintainer sends.

That's all that's needed for group use. Optionally, to DM a bot: open its link
(`t.me/<bot_username>`) and tap **Start**.

### Enrolling senders

Every bot only responds to allowlisted user IDs. The first time an unknown person messages a bot,
it replies that they aren't enrolled and logs their Telegram user ID. The maintainer adds that ID
under a named user (`centaur user add spouse --telegram <id>`) and lists the name in the repo's
`.centaur.yml` `allow` list. The
maintainer and household member each need this once, not once per bot, because IDs are stored by
person and referenced by name.

### Day-to-day use

- **Scheduled outreach** shows up as a new topic, e.g. "Garden tasks: week of Nov 23". Reply in
  the topic to continue that conversation.
- **Start a conversation:** mention the bot in the General topic, e.g. `@garden_helper_bot the
  tomatoes have yellow leaves`. The bot replies there for quick questions or opens a topic for longer ones.
- **Fresh start:** send `/new` in a topic to have the bot open a new topic without the old
  context.
- **Results:** when the agent changes a repo, its reply says so. The maintainer reviews and merges
  the PR; household members don't need to do anything.

## Slack (personal projects)

Only the maintainer uses these, so there's no non-technical onboarding.

1. Create the app from the app manifest in this repo (a template will be provided), which
   predefines scopes and the event subscription URL `<function URL>/slack/<bot>`. **Validate**
   whether one app per repo or one shared app posting under per-repo names is preferable (see
   the open questions in [plan.md](plan.md#open-questions)).
2. Install the app to the workspace; store the bot token and signing secret with `centaur bot add
   <bot> --platform slack`.
3. Set `platform: slack` in the repo's `.centaur.yml`, push to register, and invite the bot to its
   channel.
4. Enroll your Slack user ID as above.

## Adding a repo

1. Choose its platform, create the bot, and store its secrets (Telegram or Slack, above).
2. In the repo:
   - add `.centaur.yml` (bot, platform, destination, allowed users, context policy defaults,
     model, tool allowlist, persona);
   - add `.centaur/persona.md`, and any scheduled prompts under `.centaur/prompts/`;
   - add the short caller workflow in `.github/workflows/` with `repository_dispatch`, any
     `schedule:` entries, the `push` trigger for registration, and `workflow_dispatch` for manual
     runs.
3. Add secrets to the repo: the model API key (Anthropic or OpenRouter), the AWS role ARN for
   OIDC, and anything the agent's tools need (e.g. third-party API tokens).
4. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings.
5. Push to the default branch. The `register` job binds the bot; run the workflow manually once to
   confirm a test thread appears in chat.
6. If the repo is public, check that its workflow follows the no-content-in-logs rules in
   [plan.md](plan.md#security).
