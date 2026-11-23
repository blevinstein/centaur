# CLI

The `centaur` CLI manages the SSM parameters the deployed Lambda reads: bot secrets, destinations,
the admin, approved and blocked chats and users, and the GitHub token. The parameter names and types are listed in [SSM parameter
layout](plan.md#ssm-parameter-layout); this page covers usage.

## Install and run

Requires Node 24 (see `.nvmrc`).

```sh
yarn install --immutable
yarn build
npm link            # puts `centaur` on PATH; or run `node dist/cli/index.js <args>`
```

The CLI talks to SSM through the AWS SDK's default credential chain and region (for example
`AWS_PROFILE` and `AWS_REGION`). The credentials need `ssm:GetParameter`, `ssm:PutParameter`,
`ssm:GetParametersByPath`, and `ssm:DeleteParameters` on `/centaur/*`, plus KMS access for the
`SecureString` parameters. Use the same account and region as the deployed stack.

`centaur --help` and `centaur <command> --help` list the commands and flags.

## Names

Bot names and destination names given to the CLI must match `[a-z0-9][a-z0-9_-]*` (lowercase letters,
digits, `-` and `_`), the same pattern the config uses. Anything else is rejected before SSM is
touched.

## Commands

### Connections

A bot has one connection per platform, stored under
`/centaur/bots/<bot>/platforms/<platform>/` (see [SSM parameter layout](plan.md#ssm-parameter-layout)),
and one repo binding. Commands that act on a connection take `--platform <telegram|slack>`. It may
be omitted when the bot has exactly one connection; with several, the command fails with
`Bot "<x>" has several connections (...); pass --platform.` and changes nothing.

### `centaur bot add <bot> --platform <telegram|slack>`

Stores a bot's secrets for one platform. The bot is created if it does not exist; otherwise the
platform is added as a further connection and the existing ones are not touched. Secrets are never
flags; see [Supplying secrets](#supplying-secrets).

| Platform | Prompted / read | Generated |
|---|---|---|
| `telegram` | `token` | `webhook-secret` (32 random bytes, base64url) |
| `slack` | `token`, `signing-secret` | none |

Each secret is written as a `SecureString` under `/centaur/bots/<bot>/platforms/<platform>/`. The
command prints only `Added <platform> connection to bot "<bot>".`, never a secret.

```sh
centaur bot add garden --platform telegram
centaur bot add garden --platform slack      # a second connection on the same bot
```

Refuses if the bot already has a connection on that platform; there is no overwrite or rotate, so
run `bot remove --platform` first. If the command fails partway (for example a missing secret),
nothing is written before the secrets are read, and the command can simply be run again.

### `centaur bot list`

Prints one line per bot, sorted by name:
`name  repo=<owner/repo|->  <platform>:token=<set|unset> ...`, with one `<platform>:token` column
per connection (or `-` when the bot has none), followed by `github-token=<set|unset>` for the
global [GitHub token](#centaur-github-token-set). `repo` shows `-` when unbound. Only presence is
reported, never values. Prints `No bots registered.` when no `bots/` parameters exist.

### `centaur bot remove <bot> [--platform <platform>]`

Deletes one connection: every parameter under `/centaur/bots/<bot>/platforms/<platform>/`, including
its approved and blocked entries. The other connections and the repo binding are untouched, so a
bound bot can lose a connection. When it is the bot's last connection (or the bot has none), the
whole bot goes instead: every parameter under `/centaur/bots/<bot>/`, including leftovers. Other
bots whose names share a prefix (e.g. `garden-2`) are untouched. Removing the whole bot refuses if
no parameters exist for the bot or it is still bound to a repo.

### `centaur bot unbind <bot>`

Deletes `bots/<bot>/repo`, the binding written when a repo registers the bot. The secrets stay, so
the bot can be bound to a different repo, or removed. The binding is per bot, so the command takes
no `--platform`. Refuses if the bot is unknown or not bound.

```sh
centaur bot unbind garden && centaur bot remove garden
```

### `centaur bot export <file> [--force]`

Backs up every parameter under `/centaur/bots/`, `/centaur/chats/`, `/centaur/admin/` and
`/centaur/admin-claim/` to a JSON file (`{version, exportedAt, parameters: [{name, value, secure}]}`,
format version 1). **The file holds every secret in plain text**: it is created with mode 0600, so
keep it outside any repo and delete it when it is no longer needed. Refuses to overwrite an existing
file unless `--force`. The command prints the parameter count and the path, never a value.

### `centaur bot restore <file> [--force]`

Writes a backup's parameters back with their original types and reads each one back to verify it.
It works against an empty store or one that already holds some of the parameters: parameters that
already have the same value are left alone, so re-running is safe. If any parameter exists with
another value, the command lists their names (never the values), changes nothing and exits 1;
`--force` overwrites them. A file with another format version, invalid JSON, or a parameter outside
the four trees above is rejected.

```sh
centaur bot export ~/centaur-backup.json
centaur bot restore ~/centaur-backup.json
```

### `centaur destination set <bot> <name> --chat <id> [--topic <id>] [--platform <platform>]`

Binds a destination name (`/centaur/chats/<platform>/<name>`, see
[poster.md](poster.md#destinations)) to a chat, or with `--topic` to an existing Telegram topic
(its ID) or Slack thread (its timestamp). With `--topic` the record carries the platform thread ID
(`telegram:<chat>:<topic>`, `slack:<channel>:<ts>`) and `<bot>` as the owner; without it the name is
a destination with no thread. It only writes the record. A name that holds a record is replaced when
the record has no owner or belongs to the same bot, and the output says what it replaced; a thread
owned by another bot is refused. `set` never approves the chat: when the chat is not approved for
the bot's connection (or is blocked) it prints a warning that the poster refuses it until
`centaur access approve` is run, and still writes the record.

### `centaur destination list <bot> [--platform <platform>]`

Prints one line per destination of the connection, `name  chatId[  threadId]`, sorted by name, or
`No destinations for bot "<bot>" on <platform>.`. Values are read as a bare chat ID or a JSON record.

### `centaur destination remove <bot> <name> [--platform <platform>]`

Deletes the destination and refuses if there is none.

`centaur chat list` and `centaur access approve --alias` no longer exist: use `destination list`
and `destination set`. Approving a chat still creates its thread-less
destination, named from `--name`.

### `centaur admin set [--telegram <id>] [--slack <id>]`

Records the admin's user ID per platform as `/centaur/admin/<platform>`; the admin approves
[access requests](plan.md#access-requests). The admin is global, not per bot, and a bot only
notifies the admin on its own platform. At least one flag is required.

### `centaur admin claim <bot> [--platform <platform>] [--ttl-minutes <n>] [--cancel]`

Lets you become the admin without looking up your own user ID. It requires the bot to exist and
acts through one of its connections (see [Connections](#connections)); the claim is for that
connection's platform. It generates a random one-time code, and stores only its SHA-256 hash, an expiry (`--ttl-minutes`,
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
centaur admin claim garden --platform slack    # a bot with several connections
```

### `centaur admin show`

Prints the admin ID for each platform, or `not set`.

### `centaur admin remove [--telegram] [--slack]`

Deletes the admin ID for the given platforms. Bots on a platform with no admin go back to ignoring
unknown chats and refusing unknown users. Refuses if one of the platforms has no admin.

Every `access` command takes `--platform <platform>` to pick the bot's connection (see
[Connections](#connections)); approvals and blocks belong to one connection, so approving a chat on
Telegram says nothing about Slack.

### `centaur access approve <bot> <chat|user> <id> [--platform <platform>] [--name <name>]`

Approves a chat or user for one connection of a bot without waiting for a request, writing
`/centaur/bots/<bot>/platforms/<platform>/approved-chats/<id>` or `approved-users/<id>`. `--name`
records a display name for `access list`. Telegram group IDs are negative; they are accepted as-is.

Approving a chat also records a destination scoped to the connection's platform,
`/centaur/chats/<platform>/<name>` (a JSON record holding the chat ID and display name), and stores
the name on the approved entry. Name collisions are
checked within that platform only. The name is a slug of `--name` (lowercase
`[a-z0-9-]`), or `chat-<last 4 digits of the ID>` without a name. A taken name gets a numeric
suffix (`household-2`), a destination with no thread that already holds the chat is reused. Existing destinations are never overwritten, including one
bound to a thread; `destination set` replaces them. Revoking leaves the destinations in place.

### `centaur access revoke <bot> <chat|user> <id> [--platform <platform>]`

Deletes the approval. Refuses if there is none.

### `centaur access block <bot> <chat|user> <id> [--platform <platform>]` / `centaur access unblock <bot> <chat|user> <id> [--platform <platform>]`

`block` writes `/centaur/bots/<bot>/platforms/<platform>/blocked/<kind>/<id>` and deletes the subject's approval, and
refuses to block the platform's admin user ID; a blocked subject is ignored, and gets no reply or request. `unblock`
deletes the block and refuses if there is none; the subject is then unapproved and can request
access again.

### `centaur access list <bot> [--platform <platform>]`

Prints, for one connection, each approved and blocked entry as `state  kind  id  name  time`, followed by
`alias=<name>` (the stored key of the destination name) for an approved chat that has one, or `Nothing approved or blocked for "<bot>".`.

Changes take effect within about 30 seconds (the receiver's cache).

```sh
centaur admin set --telegram 111222333
centaur access approve garden user 444555666 --name "Pat"
centaur access approve garden chat <chat id> --name "Garden Club"   # destination: garden-club
centaur access list garden
```

### `centaur chat tail <bot> [--platform <platform>] [--minutes <n>] [--limit <n>] [--text] [--table <name>]`

Read-only. Lists a connection's recent messages, oldest first, through the poster's `read-channel`
reader and sender filter ([poster.md](poster.md#list-threads-and-read-channel)): only enrolled users
and the bot's own posts are shown, other bots and unenrolled senders never are, and there is no flag
to change that. It reads only the connection's approved chats.

- Telegram has no history API, so the messages come from the receiver's stored lists in the state
  table (the newest `HistoryMaxMessages` per chat, expiring `HistoryTtlDays` after the latest one).
  They are messages people sent: the bot's own posts are stored per thread, not in the chat's list,
  so they are not shown, and threads nobody replied in are omitted. The command prints a line saying so.
- Slack stores nothing; the command calls `conversations.history` with the connection's token from
  SSM, which is never printed. A Slack API error prints its code only.
- `--minutes` (default 60) bounds the age and `--limit` (default 30, at most 200) the count, newest
  kept.
- The state table is `--table`, else `CENTAUR_STATE_TABLE`, else the SSM parameter
  `/centaur/state-table` the stack publishes (present after the next `yarn deploy-prod`; until then
  pass `--table` or set the variable).

Each line is the UTC time, platform, author (`bot` or `user`), a 12-hex thread key (the hash that names
PR branches, so no chat, thread, channel or user ID is printed), the attachment count and the length
in characters. `--text` appends the text with newlines collapsed, clipped to 120 characters. A summary
line follows: messages shown, messages the sender filter dropped, the oldest message time examined,
and whether the window was exhausted (nothing older left to see).

```
time (UTC)            platform  author  thread        files  chars
2026-01-02T03:30:00Z  telegram  user    1a2b3c4d5e6f  0      11
2026-01-02T03:40:00Z  telegram  bot     1a2b3c4d5e6f  0      2
2 shown, 1 dropped by the sender filter; oldest examined 2026-01-02T03:30:00.000Z; window exhausted.
```

The AWS credentials need `ssm:GetParametersByPath` and `ssm:GetParameter` on `/centaur/*` (with KMS
decrypt) and read access to the state table.

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

### `centaur config check [path] [--global-policy <path>]`

Validates a config file (default: `.centaur.yml` or `.centaur/config.yml` in the current directory) with the same parser
the receiver and workflows use, and prints `<path> is valid.` or every issue with its dotted path.
With `mcp_servers` it also checks them against the local `.centaur/mcp-policy.cedar`, and
`--global-policy` adds the deployer's `infra/mcp-policy.cedar` ([mcp.md](mcp.md#operator-policy)).
It runs offline: no SSM access or AWS credentials are needed. It does not check that destination names resolve to anything in SSM. Exits 1 if the file is missing, is not valid YAML, or fails
the schema; see [Parsing](config.md#parsing).

```sh
centaur config check
centaur config check path/to/.centaur.yml
centaur config check path/to/.centaur/config.yml
```

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
| `Invalid <kind> name "<x>"` | Bot name or destination name outside the pattern above. |
| `Unknown platform "<x>"` | `--platform` is not `telegram` or `slack`. |
| `Bot "<x>" already has a <platform> connection; remove it first.` | `bot add` on a platform the bot is already on. |
| `Unknown bot "<x>".` | A bot command or `access`/`admin claim` on a bot with no parameters. |
| `Bot "<x>" has several connections (<platforms>); pass --platform.` | `bot remove`, `access` or `admin claim` without `--platform` on a bot with more than one connection. |
| `Bot "<x>" has no <platform> connection.` | `--platform` names a platform the bot is not on. |
| `Bot "<x>" has no connections.` | `access` or `admin claim` on a bot with only a repo binding or leftovers. |
| `Cannot read <path>: no such file` | `config check` on a path that does not exist. |
| `<path> is invalid:` followed by issues | `config check` on a file that fails validation. |
| `<file> already exists; pass --force to overwrite it.` | `bot export` to an existing path. |
| `<n> parameters already exist with another value; pass --force ...` | `bot restore` into a store holding different values. |
| `Verification failed: <name> does not read back as written.` | `bot restore` found a copy that differs from its source. |
| `No GitHub token is stored.` | `github-token remove` with nothing stored. |
| `Bot "<x>" is bound to <repo>; run "centaur bot unbind" first.` | `bot remove` of a bot's last connection while bound. |
| `Bot "<x>" is not bound to a repo.` | `bot unbind` on an unbound bot. |
| `Destination "<x>" on <platform> is bound to a thread owned by bot "<y>".` | `destination set` over a thread another bot owns. |
| `Destination "<x>" not found on <platform>.` | `destination remove` with no such name. |
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

Then push the repo's config; its `register` job binds the bot (`bots/garden/repo`) and sets
the webhook. Run `centaur admin claim garden` and open the link to become the admin; chats and users then arrive as access requests. If you already know an ID, `centaur access approve garden
chat <id> --name "Garden Club"` or `centaur access approve garden user <id>` approves it directly.
To add Slack later, run `centaur bot add garden --platform slack` (token, then signing secret).
To retire the bot, run `centaur bot unbind garden` and `centaur bot remove garden` (once per
connection when it has several, with `--platform`).
