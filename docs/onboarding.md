# Onboarding

Setup flows by role: the maintainer (once for the stack, once per bot and repo) and household
members (almost nothing). The Telegram flow and a consumer in this repo were validated in a live
run; the Slack steps are not yet verified end to end ([Still unverified](#still-unverified)).

One bot can be on several platforms. Create it on its first platform ([Telegram](#telegram-household-repos)
or [Slack](#slack-personal-projects)), then [add the other platform](#adding-a-platform-to-a-bot).
Each platform is a separate connection with its own secrets, admin, approvals and destinations.

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
Chat: Household (<chat id>)
Destination: household
React 👍 to approve, or 👎 to deny and block.
Or reply /approve k7m2qx or /deny k7m2qx.
Expires in 7 days.
```

- **👍** approves: the chat or person is added for that bot and the requester is told. A new group
  needs its chat approved, and each person in it needs their own user approval. Approving a chat
  also creates the destination shown on the request (`Destination:`), a slug of the chat's title with a
  numeric suffix if the name is taken (`chat-<last 4 digits>` when the title is unknown). Existing
  destinations are never overwritten. A scheduled prompt's `destination` names such a destination.
- **👎** denies and blocks: future attempts from that chat or user are ignored without any reply.
- Only your reaction on that DM counts, each request can be decided once, and it expires after 7
  days. The text commands `/approve <id>` and `/deny <id>` do the same if reactions don't work.
- If the bot can't DM you (you never tapped **Start**), the requester sees "I couldn't reach my
  admin." and the failure is logged with the request's IDs.
- A bot ignores unaddressed messages from unknown chats and creates at most 10 requests per hour.

Without an admin for the bot's platform, unknown chats are ignored and unknown users get "Sorry,
you aren't enrolled to talk to me." (a bot with `respond_to: all` ignores unenrolled people in the
group silently); the user ID is logged either way.

There is no allowlist in the config; access is only what you approve. Fallback, no request
needed: if you already know an ID, approve it for one connection with `centaur access approve garden
chat <id> --name "Household"` (a supergroup's ID is negative, `-100...`; the destination is named
from `--name`) or `centaur access approve garden user <id>`. Add `--platform <platform>` when the
bot has several connections. The receiver logs the IDs of unknown chats and users, so you can read
them from its logs. `centaur access list garden` shows what has been approved or blocked, and
`centaur access revoke|block|unblock` undo it. Approvals belong to one connection: approving a chat
on Telegram says nothing about Slack.

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
- **Approvers:** an approved user DMs the bot `/approver request` (Telegram) or `approver request`
  (Slack) to ask the admin to make them an approver; the admin decides with 👍 or 👎. `/approver leave`
  (`approver leave` on Slack) removes yourself. Both work in a DM only ([design](approvers.md)).
- **Results:** when the agent changes a repo, its reply links the pull request. The maintainer
  reviews and merges it; household members don't need to do anything.

## Adding a repo

Repeat for each consumer repo, after the bot exists (Telegram above, Slack below).

1. In the repo, add:
   - `.centaur.yml`, or `.centaur/config.yml` for a repo with many files under `.centaur/` ([schema](config.md): bot, `platforms` with per-platform `respond_to` and `handle`, context, model
     and cost-tuning fields, tool allowlist, persona, and a `destination` name on each
     scheduled prompt); it holds no list of chats or users;
   - `.centaur/persona.md`, and any scheduled prompts under `.centaur/prompts/`;
   - the caller workflows in `.github/workflows/` (register, message, one per scheduled prompt, and optionally
     `centaur-pr-comment.yml` to answer pull request comments), copied from
     [workflows.md](workflows.md#consumer-workflows) and
     [Comment turns](workflows.md#comment-turns).
2. In the repo's Settings > Secrets and variables > Actions:
   - **Variables** (not secrets), set for you by `scripts/set-repo-vars.sh --stack <stack>
     (--repo OWNER/REPO | --org ORG)`: `CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`,
     `CENTAUR_FUNCTION_NAME`, `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`; values are in
     [workflows.md](workflows.md#variables-and-secrets).
   - **Secret** for the bot's `provider` (`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`), plus
     anything the agent's tools need. For each secret named in `mcp_servers`, add an `env:` line to
     the `turn` step of the caller workflows and keep `Bash` out of `allowed_tools`
     ([MCP server secrets](workflows.md#mcp-server-secrets)). A repo that configures
     `mcp_servers` cannot register or run turns until its default branch has a
     `.centaur/mcp-policy.cedar` that permits them
     ([Operator policy](mcp.md#operator-policy)).
3. Settings > Actions > General: enable "Allow GitHub Actions to create and approve pull
   requests".
4. If the centaur repo is private, open its Settings > Actions > General > Access and allow
   repositories under the owner to use its actions.
5. Register the bot: push a change to the config on the default branch, or run the workflow
   manually so the `register` job runs. Check that `bots/<bot>/repo` now exists in SSM.
6. Approve the chat each scheduled prompt posts to if it is not approved yet: mention the bot there
   and answer the request, or run `centaur access approve <bot> chat <id> --name "<title>"`; the
   destination that creates is what `destination` names.
7. Run the scheduled prompt once with a manual dispatch to confirm a test topic appears, then
   message the bot. A prompt whose destination is unknown or unapproved fails with the name and
   the command to approve it.
8. If the repo is public, check that its workflow follows the no-content-in-logs rules in
   [plan.md](plan.md#security).

## Slack (personal projects)

Only the maintainer uses these, so there's no non-technical onboarding. Nothing here is validated.

Each bot, and so each repo, gets its own Slack app, mirroring Telegram.

1. Create the app: copy [slack-app-manifest.yml](slack-app-manifest.yml), replace `{{BOT_NAME}}`
   with the bot name and `{{FUNCTION_URL}}` with the receiver's Function URL (no trailing slash),
   then at [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App** > **From a
   manifest**, pick the workspace and paste it. The manifest sets the scopes, the event
   subscription URL `<function URL>/slack/<bot>`, the Messages tab so users can DM the bot, and
   socket mode off. The receiver can only answer Slack's URL verification after step 3, so retry
   the URL under **Event Subscriptions** if Slack shows it as unverified. An app created without
   the Messages tab shows "Sending messages to this app has been turned off" in its DM; enable it
   under **App Home** > **Show Tabs** > **Messages Tab** (**Allow users to send Slash commands and
   messages from the messages tab**), or re-apply the manifest.
2. Under **Basic Information** > **App Credentials**, copy the **Signing Secret**. Under **OAuth &
   Permissions**, choose **Install to Workspace** and copy the **Bot User OAuth Token**
   (`xoxb-...`).
3. Store both: `centaur bot add <bot> --platform slack` prompts for `token` (the bot token), then
   `signing-secret` ([secret inputs](cli.md#supplying-secrets)).
4. Declare `platforms: { slack: {} }` in the repo's config, push to register, and invite the bot to
   its channel (`/invite @<bot>`).
5. Become the admin: run `centaur admin claim <bot>` (add `--platform slack` when the bot has
   several connections) and DM the bot `claim <code>` with the code it prints. Later chats and users
   are admitted by [access request](#enrolling-chats-and-people); `centaur access approve <bot> user
   <id>` is the fallback.

The manifest requests only what the receiver uses: message and mention events plus the matching
`*:history` and `*:read` scopes, `chat:write`, `reactions:write` for the 👀 progress reaction,
`files:read` for attachments, `users:read` for display names, and, for access requests,
`reaction_added` with `reactions:read` (the admin's 👍/👎 arrive as `+1` and `-1`) and `im:write`
(opens the DM to the admin). `app_home` enables the writable Messages tab, which the admin claim
and access requests need, and disables the Home tab. Interactivity and slash commands are not used, so none are
registered.

`search:read.public` is optional: only the opt-in Slack search ([chat-search.md](chat-search.md))
uses it, and it is the only search scope the manifest requests. To change the scopes of an
installed app, add the scope under **OAuth & Permissions** (or update the manifest in the app
settings), then reinstall the app to the workspace; Slack adds scopes to the existing token on a
reinstall, so the bot token should stay valid (unverified here; if Slack issues a new one, update
it with `centaur bot add`). To see which scopes the installed token has, call `auth.test` with the
bot token and read the `x-oauth-scopes` response header (every Web API response carries it).

Slack decisions are reactions only; there is no `/approve` text fallback on Slack. Slack intercepts
a message starting with `/`, so `/new`, `/resume` and `/transcript` (see
[Day-to-day use](#day-to-day-use)) are unverified on Slack.

## Adding a platform to a bot

A bot keeps one repo, config and persona and gains a connection per platform. Each step has its own
revert.

1. Store the secrets: `centaur bot add garden --platform slack` (Slack prompts for the bot token,
   then the signing secret; Telegram for the token and generates the webhook secret). The existing
   connections are untouched.
2. Declare the platform in the repo's config and merge it, so `register` runs:

   ```yaml
   platforms:
     telegram: { respond_to: mention }
     slack: {}
   ```

   Each scheduled prompt's string `destination` becomes a per-platform map, as `centaur config
   check` says: `destination: { telegram: household, slack: garden-alerts }`. A prompt with a
   one-entry map posts to that platform only; several entries post the same reply to each.
   `register` fails if a declared platform has no secrets in SSM.
3. For Slack, create the app from the manifest ([Slack](#slack-personal-projects)) with the event
   URL `<function URL>/slack/<bot>`. A Telegram connection needs no step: `register` sets its
   webhook to `<function URL>/telegram/<bot>`.
4. Force a cold start (deploy, or any function configuration update): the receiver loads its
   connections once per container, so only a new container serves the new one.
5. [Claim the admin](#claiming-the-admin) for that platform if none exists, invite the bot to a
   channel and mention it; approve the chat and user as in [Enrolling chats and
   people](#enrolling-chats-and-people).

Revert: `centaur bot remove garden --platform slack` and revert the config.

## Claiming the admin

The admin is one user ID per platform, shared by every bot on that platform, so claim once per
platform. `centaur admin claim <bot> --platform <platform>` prints a one-time code (valid 15
minutes). On Telegram it is a link: open it and tap **Start**. On Slack, DM the bot `claim <code>`.
The first sender becomes the admin for that platform, and `centaur admin show` lists them. See
[the design](plan.md#bootstrapping-the-first-admin).

## Binding a destination

A scheduled prompt's `destination` is a name. Approving a chat creates one for it (named from the
chat's title); a name that holds nothing is created on first use when the connection has exactly one
approved chat. To name another chat, or to bind an **existing** Telegram topic or Slack thread so a
prompt posts there:

```sh
centaur destination set garden weekly --platform telegram --chat <chat id> --topic <topic id>
centaur destination set garden alerts --platform slack --chat <chat id> --topic <thread timestamp>
centaur destination list garden
```

- **Telegram:** the Bot API cannot list topics, so find the IDs in a message link from the topic
  (right-click a message > Copy Message Link): `t.me/c/<chat>/<topic>/<message>`. The chat ID is
  `-100` followed by `<chat>`, and `<topic>` is the topic ID.
- **Slack:** `--chat` is the channel ID and `--topic` the thread's parent message timestamp
  (the message's permalink ends in `p<ts without the dot>`; the timestamp is that number with a dot
  before the last six digits).
- Without `--topic` the name is bound to the chat alone. `set` only writes the record; the chat must
  still be approved for the connection (it warns when it is not). `centaur destination remove`
  deletes a name.

### Persistent threads

By default a scheduled prompt opens a new thread on every run. Set `thread: persistent` on a prompt
to post every run into the destination's one thread (the run sees that thread's earlier messages):

```yaml
prompts:
  weekly-plan:
    destination: { telegram: weekly-plan }
    thread: persistent
```

The thread is the one bound with `destination set --topic`, or one created and bound on the first
run. The Lambda that understands `thread` must be deployed before the config merges (`yarn
deploy-prod`, then the config), because a config on an older Lambda fails the prompt. A deleted
Telegram topic is recreated on the next run and starts without the old transcript; see
[poster.md](poster.md#destinations).

## Still unverified

- [ ] A second bot in the same group (routing between bots, Topics at this group size).
- [x] A consumer repo different from the centaur repo (`job.workflow_*` contexts, repo access).
- [ ] Slack end to end, including acknowledging webhooks within Slack's 3 seconds.

Validated in the first live run: deploy, a Telegram bot with a Topics group, registration,
message-to-reply turns, scheduled topics, `respond_to: all`, and the 👀 reaction.
