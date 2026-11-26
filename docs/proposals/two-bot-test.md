# Two test bots in this repo

Status: step 1 is built (the live bot `centaur-slack` lives in `apps/centaur-test`); step 2 (a second
bot, `centaur-test-2`, sharing conversations with it) is open. It uses the sub-folder support in
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

Maintainer actions, in order:

1. Create the bot accounts: a Telegram bot with BotFather, and a second Slack app with the same scopes
   and event subscriptions as the first; store their tokens as the stack expects.
2. `centaur bot add centaur-test-2 --platform <slack|telegram>` for each platform, then
   `centaur admin claim` for the new bot.
3. `centaur access approve` the shared chats (`centaur-test-slack`, `centaur-test`) for the new bot.
4. Set `respond_to: mention` for the new bot on both platforms. The existing bot is `respond_to: all`,
   and two `all` bots in one chat would both run on every message.

Repo changes:

- `apps/centaur-test-2/.centaur/config.yml` (`bot: centaur-test-2`, `respond_to: mention`), plus its
  persona and prompts. Destinations may repeat the existing names to share the chats.
- `centaur-register.yml`: add `apps/centaur-test-2` to the matrix and its `.centaur.yml` and
  `.centaur/**` to `paths`.
- `centaur-test-2-message.yml`: a copy of `centaur-test-message.yml` with the bot filter, `bot` and
  `root` changed; it calls the same `centaur-turn.yml`.
- `centaur-hello.yml`: add the root to the `root` options.
- `centaur-pr-comment.yml`: the `resolve` job reads the config at one `root` before it knows the bot,
  so add a per-bot copy of the workflow (for example `centaur-test-2-pr-comment.yml`) with its own
  `root`, and skip the `turn` job unless `needs.resolve.outputs.bot` is that bot. Make the existing
  workflow skip other bots' threads in the same way, or two workflows would answer one comment.
- Update `test/helpers/self-config.ts` consumers for the second config, and the self-consumer docs.
