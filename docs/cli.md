# CLI

The `centaur` CLI manages the SSM parameters the deployed Lambda reads: bot secrets, chat aliases,
the admin, approved and blocked chats and users, and the GitHub token. The parameter names and types are listed in [SSM parameter
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

Bot names and chat aliases given to the CLI must match `[a-z0-9][a-z0-9_-]*` (lowercase letters,
digits, `-` and `_`), the same pattern `.centaur.yml` uses. Anything else is rejected before SSM is
touched.

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

### `centaur bot list`

Prints one line per bot, sorted by name: `name  platform  repo=<owner/repo|->  token=<set|unset>`,
followed by `github-token=<set|unset>` for the global [GitHub token](#centaur-github-token-set).
`platform` and `repo` show `-` when missing or unbound. Only presence is reported, never values.
Prints `No bots registered.` when no `bots/` parameters exist.

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

### `centaur chat list`

Prints one line per chat alias, `name  id`, sorted by name, or `No chats registered.`.

### `centaur admin set [--telegram <id>] [--slack <id>]`

Records the admin's user ID per platform as `/centaur/admin/<platform>`; the admin approves
[access requests](plan.md#access-requests). The admin is global, not per bot, and a bot only
notifies the admin on its own platform. At least one flag is required.

### `centaur admin claim <bot> [--ttl-minutes <n>] [--cancel]`

Lets you become the admin without looking up your own user ID. It requires the bot to exist,
generates a random one-time code, and stores only its SHA-256 hash, an expiry (`--ttl-minutes`,
default 15, at most 1440) and the bot's name as `/centaur/admin-claim/<platform>`, replacing any
pending claim for that platform. Then:

- **Telegram:** prints `https://t.me/<bot_username>?start=<code>`. The username comes from
  Telegram's `getMe` with the bot's token, which is never printed. Open the link and tap **Start**.
- **Slack:** prints the code and the instruction to DM the bot `claim <code>`.

The first person to send the code to that bot in a direct message becomes the admin for the
platform (`/centaur/admin/<platform>`, overwriting any admin); the bot replies "You're now the admin
for this bot's platform." and the claim is deleted. The admin is allowed in every bot of the
platform and cannot be blocked. Five wrong codes invalidate the claim, and an expired or absent
claim is ignored like any other message. `--cancel` deletes the bot's pending claim instead and
refuses if there is none. See [plan.md](plan.md#bootstrapping-the-first-admin).

```sh
centaur admin claim garden
```

### `centaur admin show`

Prints the admin ID for each platform, or `not set`.

### `centaur admin remove [--telegram] [--slack]`

Deletes the admin ID for the given platforms. Bots on a platform with no admin go back to ignoring
unknown chats and refusing unknown users. Refuses if one of the platforms has no admin.

### `centaur access approve <bot> <chat|user> <id> [--name <name>] [--alias <alias>]`

Approves a chat or user for one bot without waiting for a request, writing
`/centaur/bots/<bot>/approved-chats/<id>` or `approved-users/<id>`. `--name` records a display
name for `access list`. Telegram group IDs are negative; they are accepted as-is.

Approving a chat also records a global chat alias, `/centaur/chats/<alias>`, and stores it on the
approved entry. `--alias` names it (chats only); otherwise it is a slug of `--name` (lowercase
`[a-z0-9-]`), or `chat-<last 4 digits of the ID>` without a name. A taken name gets a numeric
suffix (`household-2`), an alias that already names the chat is reused, and an explicit `--alias`
that names a different chat is refused. Existing aliases are never overwritten. Approving an approved chat again with a new `--alias` adds that alias and updates the entry,
keeping its name; earlier aliases stay. Revoking leaves the aliases in place.

### `centaur access revoke <bot> <chat|user> <id>`

Deletes the approval. Refuses if there is none.

### `centaur access block <bot> <chat|user> <id>` / `centaur access unblock <bot> <chat|user> <id>`

`block` writes `/centaur/bots/<bot>/blocked/<kind>/<id>` and deletes the subject's approval, and
refuses to block the platform's admin user ID; a blocked subject is ignored, and gets no reply or request. `unblock`
deletes the block and refuses if there is none; the subject is then unapproved and can request
access again.

### `centaur access list <bot>`

Prints each approved and blocked entry as `state  kind  id  name  time`, followed by
`alias=<alias>` for an approved chat that has one, or `Nothing approved or blocked for "<bot>".`.

Changes take effect within about 30 seconds (the receiver's cache).

```sh
centaur admin set --telegram 111222333
centaur access approve garden user 444555666 --name "Pat"
centaur access approve garden chat -1001234567890 --name "Garden Club"   # alias: garden-club
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
| `Invalid <kind> name "<x>"` | Bot name or alias outside the pattern above. |
| `Unknown platform "<x>"` | `--platform` is not `telegram` or `slack`. |
| `Bot "<x>" already exists; remove it first.` | `bot add` on an existing bot. |
| `Unknown bot "<x>".` | `bot remove` on a bot with no parameters, or `bot unbind` on a bot with no `platform` parameter. |
| `No GitHub token is stored.` | `github-token remove` with nothing stored. |
| `Bot "<x>" is bound to <repo>; run "centaur bot unbind" first.` | `bot remove` while bound. |
| `Bot "<x>" is not bound to a repo.` | `bot unbind` on an unbound bot. |
| `Alias "<x>" already names chat <id>.` | `access approve --alias` with a name that points at another chat. |
| `--alias applies to chats only.` | `access approve <bot> user <id> --alias ...`. |
| `Unknown kind "<x>": expected chat or user.` | `access` with a kind other than `chat` or `user`. |
| `Approved <kind> <id> not found.` / `Blocked <kind> <id> not found.` | `access revoke` / `unblock` with no such entry. |
| `No admin is set for <platform>.` | `admin remove` for a platform with no admin. |
| `Cannot block <id>: they are the admin for <platform>.` | `access block <bot> user <id>` for the admin. |
| `No pending claim for bot "<x>".` | `admin claim --cancel` with no pending claim for that bot. |
| `Could not look up the bot's username from Telegram: ...` | `admin claim` for a Telegram bot when `getMe` fails (bad token or network). |
| `--ttl-minutes must be a whole number from 1 to 1440.` | `admin claim` with a bad TTL. |
| `Missing value for <name>.` | A secret was not supplied by env, stdin, or prompt. |

AWS errors (expired credentials, missing permissions, wrong region) surface unmodified.

## Example: onboarding a Telegram bot

After creating the bot with BotFather (see [onboarding.md](onboarding.md#maintainer-once-per-bot-and-group)):

```sh
export AWS_PROFILE=centaur AWS_REGION=us-east-1
centaur bot add garden --platform telegram      # paste the BotFather token at the hidden prompt
```

Then push the repo's `.centaur.yml`; its `register` job binds the bot (`bots/garden/repo`) and sets
the webhook. Run `centaur admin claim garden` and open the link to become the admin; chats and users then arrive as access requests. If you already know an ID, `centaur access approve garden
chat <id> --name "Garden Club"` or `centaur access approve garden user <id>` approves it directly.
To retire the bot later, run `centaur bot unbind garden` and `centaur bot remove
garden`.
