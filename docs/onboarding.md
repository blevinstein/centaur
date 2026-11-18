# Onboarding

Setup flows by role: the maintainer (once for the stack, once per bot and repo) and household
members (almost nothing). The Telegram flow and a consumer in this repo were validated in a live
run; steps marked **validate** are still untested.

## Maintainer: deploy the stack (once)

1. `yarn install --immutable`.
2. Copy `parameters.example.json` to `parameters-prod.json` and fill it in (see
   [deploy.md](deploy.md#parameters-file)). An account can have only one GitHub OIDC provider:
   run `aws iam list-open-id-connect-providers` and, if `token.actions.githubusercontent.com` is
   listed, set `ExistingOidcProviderArn` to its ARN.
3. `yarn deploy-prod`. It prints the function name, function URL, role ARN and session bucket;
   you need them for the repo variables below.
4. Install the [CLI](cli.md#install-and-run) (`yarn build && npm link`) and set `AWS_PROFILE`
   and `AWS_REGION` for the stack's account.
5. Create a fine-grained GitHub PAT limited to the consumer repos with Contents: write, and store
   it: `CENTAUR_BOT_GITHUB_TOKEN=<token> centaur github-token set`. The receiver uses it to
   dispatch workflows.

## Telegram (household repos)

### Key constraint

Telegram bots can't start conversations: "A user must either add them to a group or send them a
message first." That shapes the flow:

- **Group conversations need no per-user setup on Telegram.** Once the maintainer adds a bot to the household
  group, it can post there, including scheduled outreach, and everyone in the group sees it.
- **DMs need one tap per person per bot.** Each person opens the bot and taps **Start** once.
  Until they do, the bot can't DM them. DMs are optional; the group is the main channel.

### Maintainer: once per bot and group

1. In Telegram, message [@BotFather](https://t.me/BotFather): `/newbot`, choose a display name
   (e.g. "Garden Helper") and a username ending in `bot`. Optionally set the profile so it's
   recognizable: `/setuserpic`, `/setdescription`, `/setabouttext`.
2. Store the token: `centaur bot add garden --platform telegram`. It prompts for the token and
   generates the webhook secret.
3. Create the group (e.g. "Household") with the other participant, enable **Topics** in the group
   settings (this converts it to a supergroup), add each bot, and promote it to **admin** with
   the **Manage Topics** right. Admin bots receive all group messages, and topic creation
   requires that right.
4. [Add the repo](#adding-a-repo). Its first registration sets the webhook, so the bot can
   answer your claim.
5. Become the admin: run `centaur admin claim garden`, open the link it prints, and tap **Start**.
   The bot replies "You're now the admin for this bot's platform." You never need your own user
   ID, the admin is allowed in every Telegram bot, and the same tap lets the bot DM you. The link
   works once, for 15 minutes, through that bot only; see [the
   design](plan.md#bootstrapping-the-first-admin).
6. Add the bot to the group, then mention it once. The bot DMs you a request for the chat, and
   each person in the group sends one for themselves; see below.

### Enrolling chats and people

When someone mentions or DMs the bot from a chat or as a user it doesn't know, the bot tells them
"I've asked my admin for access." and DMs the admin:

```
Access request k7m2qx
Bot: garden
Kind: chat
Requester: Pat Example (111222333)
Chat: Household (-1001234567890)
Alias: household
React 👍 to approve, or 👎 to deny and block.
Or reply /approve k7m2qx or /deny k7m2qx.
Expires in 7 days.
```

- **👍** approves: the chat or person is added for that bot and the requester is told. A new group
  needs its chat approved, and each person in it needs their own user approval. Approving a chat
  also creates the chat alias shown on the request (`Alias:`), a slug of the chat's title with a
  numeric suffix if the name is taken (`chat-<last 4 digits>` when the title is unknown). Existing
  aliases are never overwritten. A scheduled prompt's `destination` names such an alias.
- **👎** denies and blocks: future attempts from that chat or user are ignored without any reply.
- Only your reaction on that DM counts, each request can be decided once, and it expires after 7
  days. The text commands `/approve <id>` and `/deny <id>` do the same if reactions don't work.
- If the bot can't DM you (you never tapped **Start**), the requester sees "I couldn't reach my
  admin." and the failure is logged with the request's IDs.
- A bot ignores unaddressed messages from unknown chats and creates at most 10 requests per hour.

Without an admin for the bot's platform, unknown chats are ignored and unknown users get "Sorry,
you aren't enrolled to talk to me." (a bot with `respond_to: all` ignores unenrolled people in the
group silently); the user ID is logged either way.

There is no allowlist in `.centaur.yml`; access is only what you approve. Manual alternative, no
request needed: if you already know an ID, approve it for one bot with `centaur access approve
garden chat <id> --name "Household"` (a supergroup's ID is negative, `-100...`; `--alias` picks the
alias) or `centaur access approve garden user <id>`. The receiver logs the IDs of unknown chats
and users, so you can read them from its logs. `centaur access list garden` shows what has been
approved or blocked, and `centaur access revoke|block|unblock` undo it.

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
  treats every message from an approved sender in an approved group as possibly for it, and the agent may
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
   - `.centaur.yml` ([schema](config.md): bot, platform, `respond_to`, `handle`, context, model
     and cost-tuning fields, tool allowlist, persona, and a `destination` chat alias on each
     scheduled prompt); it holds no list of chats or users;
   - `.centaur/persona.md`, and any scheduled prompts under `.centaur/prompts/`;
   - the caller workflows in `.github/workflows/` (register, message, one per scheduled prompt),
     copied from [workflows.md](workflows.md#consumer-workflows).
2. In the repo's Settings > Secrets and variables > Actions:
   - **Variables** (not secrets): `CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`,
     `CENTAUR_FUNCTION_NAME`, `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`; values are in
     [workflows.md](workflows.md#variables-and-secrets).
   - **Secret** for the bot's `provider` (`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`), plus
     anything the agent's tools need.
3. Settings > Actions > General: enable "Allow GitHub Actions to create and approve pull
   requests".
4. If the centaur repo is private, open its Settings > Actions > General > Access and allow
   repositories under the owner to use its actions.
5. Register the bot: push a change to `.centaur.yml` on the default branch, or run the workflow
   manually so the `register` job runs. Check that `bots/<bot>/repo` now exists in SSM.
6. Approve the chat each scheduled prompt posts to if it is not approved yet: mention the bot there
   and answer the request, or run `centaur access approve <bot> chat <id> --name "<title>"`; the
   alias that creates is what `destination` names.
7. Run the scheduled prompt once with a manual dispatch to confirm a test topic appears, then
   message the bot. A prompt whose destination is unknown or unapproved fails with the alias and
   the command to approve it.
8. If the repo is public, check that its workflow follows the no-content-in-logs rules in
   [plan.md](plan.md#security).

## Slack (personal projects)

Only the maintainer uses these, so there's no non-technical onboarding. Nothing here is validated.

1. **Validate** Create the app from an app manifest, which predefines scopes and the event
   subscription URL `<function URL>/slack/<bot>`. No manifest exists in this repo yet. Whether
   one app per repo or one shared app posting under per-repo names is preferable is an open
   question ([plan.md](plan.md#decisions-and-open-questions)).
2. Install the app to the workspace; store the bot token and signing secret with `centaur bot add
   <bot> --platform slack`.
3. Set `platform: slack` in the repo's `.centaur.yml`, push to register, and invite the bot to its
   channel.
4. Become the admin: run `centaur admin claim <bot>` and DM the bot `claim <code>` with the code
   it prints. Later chats and users are admitted by [access
   request](#enrolling-chats-and-people); `centaur access approve <bot> user <id>` is the manual
   alternative.

For access requests the Slack app needs, beyond what it needs to read and post messages:

- the event subscription `reaction_added` (the admin's 👍/👎 arrive as `+1` and `-1`);
- bot token scopes `reactions:read`, `im:history`, `chat:write` and `im:write` (the last lets the bot
  open a DM with the admin); `im:history` also delivers the `claim <code>` DM.

Slack decisions are reactions only; there is no `/approve` text fallback on Slack.

## Still unverified

- [ ] A second bot in the same group (routing between bots, Topics at this group size).
- [x] A consumer repo different from the centaur repo (`job.workflow_*` contexts, repo access).
- [ ] Slack end to end, including acknowledging webhooks within Slack's 3 seconds.

Validated in the first live run: deploy, a Telegram bot with a Topics group, registration,
message-to-reply turns, scheduled topics, `respond_to: all`, and the 👀 reaction.
