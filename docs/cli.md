# CLI

The `centaur` CLI manages the SSM parameters the deployed Lambda reads: bot secrets, named users,
named chats, the admin, approved and blocked chats and users, and the GitHub token. The parameter names and types are listed in [SSM parameter
layout](plan.md#ssm-parameter-layout); this page covers usage.

## Install and run

Requires Node 24 (see `.nvmrc`).

```sh
npm ci
npm run build
npm link            # puts `centaur` on PATH; or run `node dist/cli/index.js <args>`
```

The CLI talks to SSM through the AWS SDK's default credential chain and region (for example
`AWS_PROFILE` and `AWS_REGION`). The credentials need `ssm:GetParameter`, `ssm:PutParameter`,
`ssm:GetParametersByPath`, and `ssm:DeleteParameters` on `/centaur/*`, plus KMS access for the
`SecureString` parameters. Use the same account and region as the deployed stack.

`centaur --help` and `centaur <command> --help` list the commands and flags.

## Names

Bot, user, and chat names must match `[a-z0-9][a-z0-9-]*` (lowercase letters, digits, `-`).
Anything else is rejected before SSM is touched.

## Commands

### `centaur bot add <bot> --platform <telegram|slack>`

Stores a new bot's secrets. Secrets are never flags; see [Supplying secrets](#supplying-secrets).

| Platform | Prompted / read | Generated |
|---|---|---|
| `telegram` | `token` | `webhook-secret` (32 random bytes, base64url) |
| `slack` | `token`, `signing-secret` | none |

Each secret is written as a `SecureString` under `/centaur/bots/<bot>/`, and `platform` is written
last as a plain `String`. The command prints only `Added <platform> bot "<bot>".`, never a secret.

```sh
centaur bot add garden --platform telegram
```

Refuses if `bots/<bot>/platform` already exists; there is no overwrite or rotate, so run `bot
remove` first. If the command fails partway (for example a missing secret), no `platform`
parameter is written and the bot can simply be added again.

### `centaur bot remove <bot>`

Deletes every parameter under `/centaur/bots/<bot>/`, including leftovers when `platform` is
missing. Other bots whose names share a prefix (e.g. `garden-2`) are untouched. Refuses if no
parameters exist for the bot or it is still bound to a repo.

### `centaur bot unbind <bot>`

Deletes `bots/<bot>/repo`, the binding written when a repo registers the bot. The secrets stay, so
the bot can be bound to a different repo, or removed. Refuses if the bot is unknown or not bound.

```sh
centaur bot unbind garden && centaur bot remove garden
```

### `centaur user add <name> [--telegram <id>] [--slack <id>]`

Records a person's platform user IDs as `/centaur/users/<name>/<platform>` (plain `String`).
Repos reference the person by `<name>` in `.centaur.yml`'s `allow` list. At least one flag is
required. Re-running overwrites the IDs given and leaves the others as they were.

```sh
centaur user add spouse --telegram 111222333 --slack U01ABCDEF
```

### `centaur user list`

Prints one line per registered user, sorted by name: `name  slack=U01ABCDEF  telegram=111222333`.
Prints `No users registered.` when there are none. User IDs are identifiers, not secrets.

### `centaur chat add <name> <id>`

Records a chat ID as `/centaur/chats/<name>` (plain `String`), overwriting any existing value.
Telegram supergroup IDs are negative; that is accepted as-is.

```sh
centaur chat add household -1001234567890
```

### `centaur chat list`

Prints one line per registered chat, `name  id`, sorted by name, or `No chats registered.`.

### `centaur admin set [--telegram <id>] [--slack <id>]`

Records the admin's user ID per platform as `/centaur/admin/<platform>`; the admin approves
[access requests](plan.md#access-requests). The admin is global, not per bot, and a bot only
notifies the admin on its own platform. At least one flag is required.

### `centaur admin show`

Prints the admin ID for each platform, or `not set`.

### `centaur admin remove [--telegram] [--slack]`

Deletes the admin ID for the given platforms. Bots on a platform with no admin go back to ignoring
unknown chats and refusing unknown users. Refuses if one of the platforms has no admin.

### `centaur access approve <bot> <chat|user> <id> [--name <name>]`

Approves a chat or user for one bot without waiting for a request, writing
`/centaur/bots/<bot>/approved-chats/<id>` or `approved-users/<id>`. `--name` records a display
name for `access list`. Telegram group IDs are negative; they are accepted as-is.

### `centaur access revoke <bot> <chat|user> <id>`

Deletes the approval. Refuses if there is none. It does not remove baseline access from
`.centaur.yml`.

### `centaur access block <bot> <chat|user> <id>` / `centaur access unblock <bot> <chat|user> <id>`

`block` writes `/centaur/bots/<bot>/blocked/<kind>/<id>` and deletes the subject's approval; a
blocked subject is ignored even if it is in `.centaur.yml`, and gets no reply or request. `unblock`
deletes the block and refuses if there is none; the subject is then unapproved and can request
access again (baseline access from `.centaur.yml` returns).

### `centaur access list <bot>`

Prints each approved and blocked entry as `state  kind  id  name  time`.

Changes take effect within about 30 seconds (the receiver's cache).

```sh
centaur admin set --telegram 111222333
centaur access approve garden user 444555666 --name "Pat"
centaur access list garden
```

### `centaur github-token set`

Stores the GitHub token the receiver uses to dispatch workflows as the `SecureString`
`/centaur/github/token`, overwriting any existing value. The secret is read as described in
[Supplying secrets](#supplying-secrets), from `CENTAUR_BOT_GITHUB_TOKEN`. The command prints only
`Stored the GitHub token.`.

```sh
CENTAUR_BOT_GITHUB_TOKEN=ghp_xxx centaur github-token set
```

### `centaur github-token remove`

Deletes `/centaur/github/token`. Refuses if no token is stored.

## Supplying secrets

For each secret the CLI needs, in order:

1. The environment variable `CENTAUR_BOT_<NAME>`, where `<NAME>` is the secret name uppercased
   with `-` replaced by `_`: `CENTAUR_BOT_TOKEN`, `CENTAUR_BOT_SIGNING_SECRET`, and `CENTAUR_BOT_GITHUB_TOKEN`. An empty
   variable counts as unset.
2. If stdin is not a terminal, one line per remaining secret, in the order of the table above
   (Slack: token, then signing secret).
3. If stdin is a terminal, a hidden prompt (`token: `, input not echoed) per remaining secret.

Values are trimmed. A missing or empty value aborts with `Missing value for <name>.` before
anything is written. Variables are shared across bots, so set them per invocation:

```sh
CENTAUR_BOT_TOKEN=123:abc centaur bot add garden --platform telegram
printf '%s\n%s\n' "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET" | centaur bot add notes --platform slack
```

## Errors

Errors are printed to stderr and the exit code is 1.

| Message | Cause |
|---|---|
| `Invalid <kind> name "<x>"` | Name outside the pattern above. |
| `Unknown platform "<x>"` | `--platform` is not `telegram` or `slack`. |
| `Bot "<x>" already exists; remove it first.` | `bot add` on an existing bot. |
| `Unknown bot "<x>".` | `bot remove` on a bot with no parameters, or `bot unbind` on a bot with no `platform` parameter. |
| `No GitHub token is stored.` | `github-token remove` with nothing stored. |
| `Bot "<x>" is bound to <repo>; run "centaur bot unbind" first.` | `bot remove` while bound. |
| `Bot "<x>" is not bound to a repo.` | `bot unbind` on an unbound bot. |
| `Pass at least one of --telegram, --slack.` | `user add` with no ID flags. |
| `Unknown kind "<x>": expected chat or user.` | `access` with a kind other than `chat` or `user`. |
| `Approved <kind> <id> not found.` / `Blocked <kind> <id> not found.` | `access revoke` / `unblock` with no such entry. |
| `No admin is set for <platform>.` | `admin remove` for a platform with no admin. |
| `Missing value for <name>.` | A secret was not supplied by env, stdin, or prompt. |

AWS errors (expired credentials, missing permissions, wrong region) surface unmodified.

## Example: onboarding a Telegram bot

After creating the bot with BotFather, read the group and user IDs with `getUpdates` before the
webhook is set (see [onboarding.md](onboarding.md#maintainer-once-per-bot-and-group)):

```sh
export AWS_PROFILE=centaur AWS_REGION=us-east-1
centaur bot add garden --platform telegram      # paste the BotFather token at the hidden prompt
centaur chat add household -1001234567890       # group chat ID (negative) from getUpdates
centaur user add spouse --telegram 111222333    # user ID from getUpdates
```

Then push the repo's `.centaur.yml`; its `register` job binds the bot (`bots/garden/repo`) and sets
the webhook. To retire the bot later, run `centaur bot unbind garden` and `centaur bot remove
garden`.
