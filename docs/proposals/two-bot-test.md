# Two test bots in this repo

Status: step 1 is built (the live bot `centaur-slack` lives in `apps/centaur-test`); step 2 (a second
bot, `centaur-test-2`) is built on the repo side; the maintainer actions below are open. It uses the sub-folder support in
[subfolder-support](subfolder-support.md) and the templates in
[workflows](../workflows.md#bots-in-sub-folders).

## Step 1: the move

`.centaur/` moved to `apps/centaur-test/.centaur/`. The bot name stays `centaur-slack`, so its SSM
data, access lists, admin claim and registry entry are unchanged. The `centaur-*.yml` workflows pass
`root: apps/centaur-test`; every config path (`persona`, prompt files, the MCP policy, consumer skills)
is relative to that root and did not change.

Rollout: the move commit changes `apps/centaur-test/.centaur/**`, so `Centaur register` runs from it
and re-binds the bot. `main` must have the Lambda with sub-folder support deployed first. Rollback is
reverting the commit; register runs again from the revert.

## Step 2: the second bot

`centaur-test-2` is on Slack and Telegram and answers mentions on both (`respond_to: mention`; the first bot is `all`, and
two `all` bots in one chat would both run on every message). It has no MCP
server (so no extra secrets), no prompts and no destinations: destinations are one shared namespace
per platform (`chats/<platform>/<name>`), so a name reused from the first bot would share its chat
record, and a new name needs a chat approved first. Add prompts once the maintainer picks a name.

Repo side (built):

- `apps/centaur-test-2/.centaur/config.yml` and `persona.md`.
- `centaur-register.yml`: the root is in the matrix and in `paths`.
- `centaur-test-2-message.yml`: the thin caller of `centaur-turn.yml`, filtered on the bot.
- `centaur-hello.yml`: the root is a `root` option (it has no prompt to run yet).
- `centaur-comment-turn.yml`: the PR-comment `resolve` and `turn` jobs as a reusable workflow with `bot`
  and `root` inputs; `centaur-pr-comment.yml` and `centaur-test-2-pr-comment.yml` call it. `resolve`
  takes the bot from the pull request's thread record in the poster, not from the config at `root`
  (which only supplies the allowed commenter associations), so it succeeds in both copies for any
  `centaur/` branch. Only the copy whose `bot` input equals `needs.resolve.outputs.bot` runs `turn`;
  the other copy's `turn` job is skipped, which is neutral rather than failed.
- `test/self-consumer.test.ts` validates the second config.

Maintainer actions, in order:

1. Create the Slack app (done) and store its token and signing secret. Set its event URL to
   `<function URL>/slack/centaur-test-2`.
2. `centaur bot add centaur-test-2 --platform slack` (if the token is not already stored by that
   command), then merge this change so `Centaur register` runs and binds the bot to the repo.
3. `centaur admin claim centaur-test-2 --platform slack`. The claim code is generated from the
   registered bot, so run it after register.
4. The receiver builds its bot list once per warm execution environment (`src/lambda/handler.ts`
   caches the build; `createReceiver` calls `loadBots` once), so a bot bound after the environment
   started is not routed until a fresh environment starts. A normal deploy (`update-function-code`)
   or any function configuration change retires warm environments, and an idle Lambda also
   cold-starts on the next request. The cheapest nudge is a small function configuration update (for
   example changing the description); it is a live change, so the maintainer runs or approves it.
   Reloading without a restart is the open backlog item in `TODO.md`.
5. `centaur access approve` the shared Slack chat for the new bot, and invite the app to it.
6. Telegram: create the bot with BotFather and store its token and webhook secret. The register run sets the
   webhook. The admin is one per platform, shared by every bot on it, so `centaur admin claim centaur-test-2
   --platform telegram` is only needed if the maintainer is not already the Telegram admin through the first
   bot. `centaur access approve` the shared Telegram group for the new bot, and add the bot to the group.
   Privacy mode and admin rights only matter for `respond_to: all`, so `mention` needs neither.

## Direct-mode trial (finished)

`centaur-test-2` ran with `execution: { mode: direct }` and `pull_requests: { existing: off }` on this
repository's unprotected default branch, with a persona limiting edits to a scratch directory (a prompt-level
restriction only). The configuration has since been reverted.

Verified:

- An unprotected branch accepted the direct push.
- The commit carried the run-URL footer and was unsigned.
- The `GITHUB_TOKEN` push triggered no workflow.

Not verified (tracked in `TODO.md` section 22):

- Rejection by a protected branch, and the fallback pull request that follows.
- A ruleset bypass actor.
- The protected-path fallback (an edit to a protected path such as `.github/` or `.centaur*`).
  The maintainer asked both bots in a shared chat to edit the trial bot's persona (a protected path); both
  refused at the persona level, so the harness path was not reached and only the unit tests on real git
  repos cover it. A live check needs a bot whose persona allows editing a protected path.

## Bot-to-bot mentions

Both bots set `platforms.slack.bot_messages: mention`, so each accepts a Slack message written by the
other when it explicitly @mentions it (in both `respond_to` modes). Telegram stays at `ignore`: the
Bot API does not normally deliver other bots' messages to a bot, so the setting would be inert there.

The sender approval check still applies, so each bot's Slack user ID must be approved on the other
bot's Slack connection (the ID is in the bot's own messages, or in `centaur access list`):

```sh
centaur access approve centaur-slack user <centaur-test-2 Slack user ID> --platform slack
centaur access approve centaur-test-2 user <centaur-slack Slack user ID> --platform slack
```

Result (2026-11-26): with both approvals in place, a message posted as `centaur-slack` in the shared
Slack test channel that mentioned `centaur-test-2` was answered by `centaur-test-2` in the thread
within about 40 seconds. Its workflow ran and succeeded; `centaur-slack`'s workflow for the same
dispatch was skipped by its bot filter. The reply mentioned no one, so `centaur-slack` ignored it and
the thread stayed at one reply with no further runs. Not covered: the reverse direction (same path,
settings and approval) and a deliberate loop (the test told the bot not to mention anyone back).

Loop risk: there is no allowlist and no hop cap, so two bots that keep mentioning each other will
loop; the per-turn spend cap and the agents not re-mentioning each other are the only brakes. To stop
a loop, set `bot_messages: ignore` on one bot and push (register applies it), or lower the per-turn
spend cap.

The key takes effect after the `Centaur register` run on merge and needs no deploy, provided the
deployed Lambda already parses `bot_messages` (it was introduced in commit `a04e95f`, which precedes
the current deployed Lambda); a Lambda without it rejects the unknown key.

## Live checks (sub-folder slice 5)

Two checks remain from [subfolder-support](subfolder-support.md): lazy loading of a nested guide, and
a message that reaches both bots. Run them in the order below, with real turns on this repository.

### Fixture

`apps/centaur-test-2/livecheck/` holds `target.txt` (a one-line file with no marker) and its own
`AGENTS.md`, the only file that contains the marker word (read it there to know the expected answer; it is written nowhere else, but the bot can search the repository, so the run log, not the reply alone, shows whether the guide loaded by itself). `centaur-test-2`'s root has
no guide, so its prompt carries no instruction to read one, and the marker is in no config, persona or
prompt. The agent can only know the word by loading `livecheck/AGENTS.md` itself.

### Check 1: a nested guide loads lazily

1. In the shared Slack chat, mention `centaur-test-2`: "Read apps/centaur-test-2/livecheck/target.txt
   and tell me the nested marker word." Do not say where the word lives: the wording must not hint at the nested guide or its folder beyond naming `target.txt`.
2. Expected: the bot replies with the marker word from `livecheck/AGENTS.md`. Read it with `centaur chat tail centaur-test-2
   --platform slack --text --replies`.
3. Negative check, in the same thread or a new one: mention the bot with "What is the nested marker
   word?" without asking it to read the file. Expected: it does not know the word, or says it has to
   read a file. The word appearing here means it leaked into the normal prompt or persona (the
   guide is installed to the user memory only for a root guide, and this root has none).
4. Evidence in the run log (`gh run view <id> --log` for the `Centaur Test 2 message` run): the
   prompt step shows the project-folder line and no marker word; the agent's tool calls show a
   `Read` of `target.txt`. `rg` for the marker word over the downloaded log should hit only the agent's
   tool output and reply, never the prompt.
5. If the bot does not know the word after reading `target.txt`, the guide did not load. Claude Code
   documents `CLAUDE.md` lazy loading, not `AGENTS.md`, so repeat with the file renamed to
   `CLAUDE.md` (a temporary change) to tell "nested guides do not load" from "`AGENTS.md` is not read".
   Record the outcome in `docs/config.md` either way: if only `CLAUDE.md` loads lazily, the
   explicit prompt instruction stays the only channel for `AGENTS.md`.

### Check 2: one message to both bots

`centaur-test` answers every message (`respond_to: all`); `centaur-test-2` answers only mentions.
Run on Slack, then on Telegram, in the chat both bots are approved for. For each case note the reply
count and the replying bot's identity (name and avatar on Slack, bot username on Telegram).

1. A plain message that mentions neither bot. Expected: one reply, from `centaur-test`. No run for
   `centaur-test-2`.
2. A message mentioning only `centaur-test-2`. Expected: one reply, from `centaur-test-2`, and
   `centaur-test` also answers because it takes all messages; so exactly one reply from each bot,
   none duplicated.
3. A message mentioning both bots. Expected: one reply from each, each bot's own identity, never
   two from one bot.
4. Evidence: `centaur chat tail centaur-test --platform <p> --replies` and the same for
   `centaur-test-2`; each shows its own reply once. In Actions, each message has one `Centaur turn`
   run per answering bot: the other bot's caller workflow is skipped by its `client_payload.bot`
   filter, and the two runs sit in different concurrency groups (the group embeds the bot and
   thread key), so neither cancels or queues behind the other. A cancelled or doubled run is a
   failure.
5. Expected for bot-to-bot: `centaur-test-2`'s reply must not start a further turn unless it
   mentions the other bot (`bot_messages: mention`); the runs stop after one per bot.

Report per case: reply count per bot, replying identity, run ids by bot, any skipped or cancelled run.

## Live checks (skills resume)

Two open points from [skills-rules.md](../skills-rules.md#live-check-results): whether an invoked
skill's body survives a `resume` thread, and whether `Skill` must be in `--allowedTools`.
`centaur-test-2` carries the consumer skill `apps/centaur-test-2/.claude/skills/livecheck-passphrase`
(installed as `centaur-consumer-livecheck-passphrase`, since `skills.consumer` defaults to `true`; no
config change). Its body holds a passphrase that appears nowhere else in the repository, so an
answer containing it came from the skill body. The skill is only for these checks; delete it
afterwards.

Prerequisites: the skill is on the default branch (consumer skills come from the trusted checkout),
and the `Centaur register` run has finished. Use a fresh thread per check, mention `centaur-test-2`
in every message, and read each reply with
`centaur chat tail centaur-test-2 --platform slack --text --replies` (it clips to 120 characters, so
the prompts below ask for the answer first, on one line). The run's execution file (the
`execution_file` output of the turn) shows the `Skill` tool calls and the init message's skills
listing.

### A. Is the skill body retained across `resume`?

1. New thread. Send `/resume` (acknowledged in the thread, no agent turn).
2. Send: `@centaur-test-2 invoke the centaur-consumer-livecheck-passphrase skill and reply with only its passphrase.`
   Expect the passphrase in the reply, and a `Skill` tool call in the execution file.
3. Wait for the reply, then send in the same thread: `@centaur-test-2 without invoking any skill or tool, what is the skill passphrase? Reply with only the passphrase, or UNKNOWN.`
4. Read the 2nd run's execution file (the run log). The run restored the saved session (a `--resume <id>` in `claude_args`).
   - Retained: the answer is the passphrase and the execution file has no new `Skill` call. The body survived the resume.
   - Not retained: the answer is `UNKNOWN` (or the agent invokes the skill again despite the instruction, which shows the body was not in the restored context). Record which.
   - Inconclusive: the passphrase with a new `Skill` call, because the instruction was ignored.
5. Optional variant: repeat on a thread without `/resume` (the config default is `transcript`). The transcript holds only chat text, so the 2nd answer should be the passphrase only if the 1st reply quoted it, which makes this a weak control; use step 6 for the real one.

### B. Negative control

6. New thread, `/resume`, then send only the step 3 message, with no earlier skill invocation.
   Expect `UNKNOWN` and no `Skill` call. A passphrase here means it leaked from a prompt, persona or
   config: stop and re-run `rg --hidden` for the passphrase (read it from the skill file) over the checkout.

### C. Does `Skill` need to be in `--allowedTools`?

`prepare` adds `Skill` to `--allowedTools` whenever a skill was installed. To test without it,
push an experiment branch (AGENTS.md "Workflow experiments") whose `prepare` omits `skillRule` in
`buildClaudeArgs` (`src/workflows/prepare.ts`), dispatch the workflow from it, and repeat steps 1 and 2
in a new thread.

7. Confirm in the run's `claude_args` that `Skill` is absent from `--allowedTools`.
8. Evidence: if the passphrase is returned and the execution file has a successful `Skill` call,
   `Skill` is not required (still harmless to leave). If the tool call is denied or the agent says it
   cannot load the skill, it is required. Record the wording, and drop the experiment branch.

Never paste chat IDs or tokens into the results; record outcomes in
[skills-rules.md](../skills-rules.md#live-check-results) and tick the TODO item.
