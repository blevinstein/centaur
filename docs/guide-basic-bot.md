# Guide: a response-only bot

A consumer repo whose bot only replies in chat: no scheduled prompts, no MCP servers. This guide
is the shortest path; each step links to the reference for the details.

Prerequisites: the stack is deployed and the CLI installed
([onboarding](onboarding.md#maintainer-deploy-the-stack-once)).

## 1. Config

Add `.centaur.yml` (or `.centaur/config.yml`, [location](config.md#location)) to the repo. The
required keys are `bot`, `platforms`, `provider`, `model` and `allowed_tools`; everything else has a
default ([fields](config.md#fields)):

```yaml
bot: my-bot
platforms:
  telegram: {}          # or slack: {}
provider: anthropic
model: sonnet
allowed_tools: "Read,Edit,Write,Glob,Grep"
```

Optionally add `.centaur/persona.md` (the default `persona` path) to tell the agent who it is. The
config holds no list of chats or users; access is approved separately in step 5. Check the file
offline with `centaur config check` ([CLI](cli.md#centaur-config-check-path---global-policy-path)).

## 2. Workflows

Copy the register and message workflows from
[Consumer workflows](workflows.md#consumer-workflows) into `.github/workflows/`:
`centaur-register.yml` and `centaur-message.yml`, replacing `<owner>/centaur` with the centaur
repo. A response-only bot needs no other workflow.

## 3. Repo settings

Run `centaur repo vars` in the repo to set the Actions variables, add the API key secret for your
`provider`, and enable "Allow GitHub Actions to create and approve pull requests"
([Adding a repo](onboarding.md#adding-a-repo), steps 2 and 3).

## 4. Create the bot

Create the bot on its platform ([Telegram](onboarding.md#telegram-household-repos) or
[Slack](onboarding.md#slack-personal-projects)), then store its secrets:

```sh
centaur bot add my-bot --platform telegram   # prompts for the token
```

## 5. Register and try it

1. Merge the config to the default branch. The `register` workflow runs on that push (or run it
   from the Actions tab); afterwards `bots/my-bot/repo` exists in SSM
   ([CLI](cli.md)).
2. Claim the admin: `centaur admin claim my-bot` ([details](onboarding.md#claiming-the-admin)).
3. Mention the bot in a chat (or DM it). It answers "I've asked my admin for access" and DMs you
   the request; react 👍 to approve ([details](onboarding.md#enrolling-chats-and-people)). Then
   message it again.
4. The 👀 reaction shows while the turn runs, and the reply lands in the thread. A change to the
   repo arrives as a pull request the reply links.

If nothing happens, `centaur chat tail my-bot` lists the bot's recent messages
([CLI](cli.md)), and the repo's Actions tab shows the `Centaur message` run.

Next: [add a scheduled action](guide-scheduled-action.md).
