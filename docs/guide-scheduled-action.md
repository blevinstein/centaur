# Guide: add a scheduled action

A scheduled action is a prompt that runs on a cron schedule and starts a thread in a chat by
itself. It builds on a working bot ([guide](guide-basic-bot.md)).

## 1. Write the prompt

Create `.centaur/prompts/weekly-tasks.md`, the default `file` for a prompt named `weekly-tasks`.
It is what you would tell the agent to do on this run, for example "Look at the notes and post this
week's open tasks".

## 2. Declare it in the config

Add a `prompts` entry ([reference](config.md#prompts)). `destination` is required and maps each
platform to a destination name; a one-entry map posts to that platform only, several entries post
the same reply to each:

```yaml
prompts:
  weekly-tasks:
    destination:
      telegram: household
      slack: team-alerts
```

Optional keys: `file`, `context` (default `context.scheduled`, `fresh`) and `thread` (`new`, the
default, or `persistent` for one thread per destination). A plain string `destination` is allowed
only while the bot has a single platform. Every platform used must be declared under `platforms`.
Validate with `centaur config check`.

## 3. Add the workflow

Copy the scheduled workflow from [Consumer workflows](workflows.md#consumer-workflows)
(`centaur-weekly-tasks.yml`), setting `prompt_name` in both places and the `cron` under
`schedule:`. The cron lives only in the workflow; GitHub ignores schedules outside the default
branch. It keeps `workflow_dispatch` so you can run it by hand.

## 4. Make the destination exist

A destination is a name for an approved chat. Approving a chat creates one named after the chat's
title (shown on the access request as `Destination:`); to name another chat, or bind an existing
topic or thread, use `centaur destination set`
([Binding a destination](onboarding.md#binding-a-destination)). `centaur destination list my-bot`
shows what exists. A destination that is unknown or unapproved fails the run with the name and the
`centaur access approve` command that fixes it ([access](config.md#access)).

## 5. Test it

Merge the config and workflow to the default branch (the register workflow re-runs on the config
change), then dispatch the workflow without waiting for the cron:

```sh
gh workflow run centaur-weekly-tasks.yml
```

## 6. See the output

- In chat: a new thread (a topic on Telegram) appears in the destination with the reply. Replying
  there continues the conversation with the prompt's context policy.
- In GitHub: the run in the repo's Actions tab, plus a pull request if
  the agent changed files. A failed run posts a notice in the thread when one exists.
- From the CLI: `centaur chat tail my-bot` lists the bot's recent messages
  ([CLI](cli.md)).

More: [persistent threads](onboarding.md#persistent-threads),
[how a scheduled turn runs](workflows.md#agent-turn).
