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

## Direct-mode trial

Temporary: `centaur-test-2` runs with `execution: { mode: direct }` and `pull_requests: { existing: off }`
in `apps/centaur-test-2/.centaur/config.yml`, so its chat turns commit straight to this repository's
default branch (see [Execution modes](../workflows.md#execution-modes)). Main is unprotected here, and the
persona restricts the bot to `scratch/` (a prompt-level restriction only). The trial exists to exercise
direct mode, including its pull request fallback, against a real repository.

Test plan:

1. Ask the bot to create `scratch/direct-smoke.txt`. Expect a commit on main by `github-actions[bot]`
   with a run-URL footer, and the reply `Pushed to main: <commit url>`.
2. Ask the bot to edit its own persona file. Expect a fallback pull request that names the protected
   path as the reason.
3. Confirm the `GITHUB_TOKEN` push triggered no workflow runs.
4. Optional: add a branch protection rule requiring a pull request, repeat step 1 and expect a
   `push_rejected` fallback pull request.

Revert: remove the `execution` and `pull_requests` keys from the config, restore the persona wording
about changes being opened as a pull request, and delete `scratch/` if wanted.
